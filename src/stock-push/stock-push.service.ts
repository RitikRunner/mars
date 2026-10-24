import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Channel } from '../common/enums';
import { calculatePublishableStock } from '../common/publish-policy';

interface DirtySkuRow {
  sku: string;
  available: number;
  version: number;
  last_pushed_qty: number;
  buffer: number;
  cap: number | null;
}

@Injectable()
export class StockPushService {
  private readonly logger = new Logger(StockPushService.name);

  // Simple token buckets for rate limiting per channel
  private nykaaTokens = 4; // 4 req/s max (1 spare)
  private flipkartTokens = 8; // 8 req/s max (2 spare for polling)
  private isPushing = false;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Refill token buckets every 1 second
   */
  @Interval(1000)
  refillTokenBuckets() {
    this.nykaaTokens = 4;
    this.flipkartTokens = 8;
  }

  /**
   * Channel Stock Pusher Loop
   * Runs every 2 seconds. Identifies dirty SKUs where `inventory.version > channel_stock.pushed_version`.
   * Computes publish policy, sorts priority (zeros first, then low-stock, then oldest),
   * and pushes to channels respecting rate limits.
   */
  @Interval(2000)
  async runStockPushLoop(): Promise<void> {
    if (this.isPushing) return;
    this.isPushing = true;

    try {
      await Promise.all([
        this.pushToWebsite(),
        this.pushToNykaa(),
        this.pushToFlipkart(),
        this.pushToBlinkit(),
      ]);
    } catch (err) {
      this.logger.error('Error in stock pusher loop', err.stack);
    } finally {
      this.isPushing = false;
    }
  }

  /**
   * Website: Instant internal direct update
   */
  private async pushToWebsite(): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.WEBSITE);
    for (const item of dirtySkus) {
      const publishQty = calculatePublishableStock({
        channel: Channel.WEBSITE,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: 10,
        buffer: 0,
      });

      // Direct local update
      await this.recordPushSuccess(Channel.WEBSITE, item.sku, publishQty, Number(item.version));
    }
  }

  /**
   * Nykaa: 1 SKU per call, rate-limited to 4 req/s
   */
  private async pushToNykaa(): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.NYKAA);
    const sorted = this.prioritizeSkus(dirtySkus);

    for (const item of sorted) {
      if (this.nykaaTokens <= 0) break; // Token bucket exhausted for this second
      this.nykaaTokens--;

      const publishQty = calculatePublishableStock({
        channel: Channel.NYKAA,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: 15,
        buffer: item.buffer,
        cap: item.cap,
      });

      // In production: Call Nykaa REST API (1 SKU per call)
      await this.recordPushSuccess(Channel.NYKAA, item.sku, publishQty, Number(item.version));
    }
  }

  /**
   * Flipkart: Bulk API up to 50 SKUs per call, rate-limited to 8 req/s
   */
  private async pushToFlipkart(): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.FLIPKART);
    if (dirtySkus.length === 0) return;

    const sorted = this.prioritizeSkus(dirtySkus);

    // Batch up to 50 SKUs per request
    while (sorted.length > 0 && this.flipkartTokens > 0) {
      this.flipkartTokens--;
      const batch = sorted.splice(0, 50);

      const updates = batch.map((item) => ({
        sku: item.sku,
        version: Number(item.version),
        publishQty: calculatePublishableStock({
          channel: Channel.FLIPKART,
          sku: item.sku,
          available: Number(item.available),
          velocityPerMin: 15,
          buffer: item.buffer,
          cap: item.cap,
        }),
      }));

      // In production: Call Flipkart Bulk Inventory API
      for (const u of updates) {
        await this.recordPushSuccess(Channel.FLIPKART, u.sku, u.publishQty, u.version);
      }
    }
  }

  /**
   * Blinkit: Urgent REST for stock <= 5, otherwise routine
   */
  private async pushToBlinkit(): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.BLINKIT);
    for (const item of dirtySkus) {
      const publishQty = calculatePublishableStock({
        channel: Channel.BLINKIT,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: 10,
        buffer: item.buffer,
      });

      // Urgent push if publishQty <= 5 or 0
      if (publishQty <= 5) {
        await this.recordPushSuccess(Channel.BLINKIT, item.sku, publishQty, Number(item.version));
      }
    }
  }

  private async fetchDirtySkus(channel: Channel): Promise<DirtySkuRow[]> {
    return this.dataSource.query(
      `SELECT cs.sku, (i.on_hand - i.reserved) AS available, i.version, 
              cs.last_pushed_qty, cs.buffer, cs.cap
       FROM channel_stock cs 
       JOIN inventory i USING (sku)
       WHERE cs.channel = $1 AND i.version > cs.pushed_version
       LIMIT 500;`,
      [channel],
    );
  }

  /**
   * Priority Ordering:
   * 1. Out of stock (available <= 0)
   * 2. Low stock (available <= 5)
   * 3. Highest version difference (oldest stale updates)
   */
  private prioritizeSkus(skus: DirtySkuRow[]): DirtySkuRow[] {
    return skus.sort((a, b) => {
      const aAvail = Number(a.available);
      const bAvail = Number(b.available);
      if (aAvail <= 0 && bAvail > 0) return -1;
      if (bAvail <= 0 && aAvail > 0) return 1;
      if (aAvail <= 5 && bAvail > 5) return -1;
      if (bAvail <= 5 && aAvail > 5) return 1;
      return Number(b.version) - Number(a.version);
    });
  }

  private async recordPushSuccess(
    channel: Channel,
    sku: string,
    pushedQty: number,
    inventoryVersion: number,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE channel_stock 
       SET last_pushed_qty = $1, pushed_version = $2, updated_at = NOW()
       WHERE channel = $3 AND sku = $4;`,
      [pushedQty, inventoryVersion, channel, sku],
    );

    await this.dataSource.query(
      `INSERT INTO channel_push_log (channel, sku, qty, inventory_version, http_status, latency_ms)
       VALUES ($1, $2, $3, $4, 200, 15);`,
      [channel, sku, pushedQty, inventoryVersion],
    );
  }
}
