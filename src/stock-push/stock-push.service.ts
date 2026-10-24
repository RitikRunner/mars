import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Channel } from '../common/enums';
import {
  calculatePublishableStock,
  DEFAULT_BLIND_WINDOWS,
  DEFAULT_FLOORS,
} from '../common/publish-policy';

interface DirtySkuRow {
  sku: string;
  available: number;
  version: number;
  last_pushed_qty: number;
  buffer: number;
  cap: number | null;
  updated_at: Date;
}

@Injectable()
export class StockPushService {
  private readonly logger = new Logger(StockPushService.name);

  private nykaaTokens = 4;
  private flipkartTokens = 8;
  private blinkitTokens = 4;
  private isPushing = false;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Channel Stock Pusher Loop (DESIGN.md §5)
   * Runs every 1 second. Each bucket holds one second of tokens.
   */
  @Interval(1000)
  async runStockPushLoop(): Promise<void> {
    if (this.isPushing) return;
    this.isPushing = true;

    // Refill token buckets for this 1-second window
    this.nykaaTokens = 4;
    this.flipkartTokens = 8;
    this.blinkitTokens = 4;

    try {
      const velocities = await this.computeVelocities();

      await Promise.all([
        this.pushToWebsite(velocities),
        this.pushToNykaa(velocities),
        this.pushToFlipkart(velocities),
        this.pushToBlinkit(velocities),
      ]);
    } catch (err: any) {
      this.logger.error('Error in stock pusher loop', err.stack);
    } finally {
      this.isPushing = false;
    }
  }

  /**
   * Computes per-SKU velocity from stock_ledger for the last 15 minutes
   */
  private async computeVelocities(): Promise<Map<string, number>> {
    const planned = Number(process.env.SALE_PLANNED_VELOCITY || 0);
    const map = new Map<string, number>();

    try {
      const rows = await this.dataSource.query(`
        SELECT sku, COALESCE(SUM(delta_reserved), 0) / 15.0 AS velocity
        FROM stock_ledger
        WHERE reason = 'RESERVE' AND created_at >= NOW() - INTERVAL '15 minutes'
        GROUP BY sku;
      `);

      for (const r of rows) {
        map.set(r.sku, Math.max(Number(r.velocity), planned));
      }
    } catch (err: any) {
      this.logger.error('Error computing velocities', err.message);
    }

    return map;
  }

  /**
   * Website: Instant internal direct update
   */
  private async pushToWebsite(velocities: Map<string, number>): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.WEBSITE);
    for (const item of dirtySkus) {
      const velocity = velocities.get(item.sku) ?? Number(process.env.SALE_PLANNED_VELOCITY || 0);
      const publishQty = calculatePublishableStock({
        channel: Channel.WEBSITE,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: velocity,
        buffer: 0,
      });

      if (publishQty === Number(item.last_pushed_qty)) {
        // Quantity unchanged: update pushed_version only, no call, no log row
        await this.updatePushedVersionOnly(Channel.WEBSITE, item.sku, Number(item.version));
        continue;
      }

      await this.sendToWebsite(item.sku, publishQty);
      await this.recordPushSuccess(Channel.WEBSITE, item.sku, publishQty, Number(item.version));
    }
  }

  /**
   * Nykaa: 1 SKU per call, rate-limited to 4 req/s
   */
  private async pushToNykaa(velocities: Map<string, number>): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.NYKAA);
    const sorted = this.prioritizeSkus(Channel.NYKAA, dirtySkus, velocities);

    for (const item of sorted) {
      if (this.nykaaTokens <= 0) break;

      const velocity = velocities.get(item.sku) ?? Number(process.env.SALE_PLANNED_VELOCITY || 0);
      const publishQty = calculatePublishableStock({
        channel: Channel.NYKAA,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: velocity,
        buffer: item.buffer,
        cap: item.cap,
      });

      if (publishQty === Number(item.last_pushed_qty)) {
        await this.updatePushedVersionOnly(Channel.NYKAA, item.sku, Number(item.version));
        continue;
      }

      this.nykaaTokens--;
      await this.sendToNykaa(item.sku, publishQty);
      await this.recordPushSuccess(Channel.NYKAA, item.sku, publishQty, Number(item.version));
    }
  }

  /**
   * Blinkit: 1 SKU per call, rate-limited to 4 req/s, prioritised
   */
  private async pushToBlinkit(velocities: Map<string, number>): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.BLINKIT);
    const sorted = this.prioritizeSkus(Channel.BLINKIT, dirtySkus, velocities);

    for (const item of sorted) {
      if (this.blinkitTokens <= 0) break;

      const velocity = velocities.get(item.sku) ?? Number(process.env.SALE_PLANNED_VELOCITY || 0);
      const publishQty = calculatePublishableStock({
        channel: Channel.BLINKIT,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: velocity,
        buffer: item.buffer,
        cap: item.cap,
      });

      if (publishQty === Number(item.last_pushed_qty)) {
        await this.updatePushedVersionOnly(Channel.BLINKIT, item.sku, Number(item.version));
        continue;
      }

      this.blinkitTokens--;
      await this.sendToBlinkit(item.sku, publishQty);
      await this.recordPushSuccess(Channel.BLINKIT, item.sku, publishQty, Number(item.version));
    }
  }

  /**
   * Flipkart: Bulk API up to 50 SKUs per call, rate-limited to 8 req/s
   */
  private async pushToFlipkart(velocities: Map<string, number>): Promise<void> {
    const dirtySkus = await this.fetchDirtySkus(Channel.FLIPKART);
    if (dirtySkus.length === 0) return;

    const sorted = this.prioritizeSkus(Channel.FLIPKART, dirtySkus, velocities);
    const toPush: { item: DirtySkuRow; publishQty: number }[] = [];

    for (const item of sorted) {
      const velocity = velocities.get(item.sku) ?? Number(process.env.SALE_PLANNED_VELOCITY || 0);
      const publishQty = calculatePublishableStock({
        channel: Channel.FLIPKART,
        sku: item.sku,
        available: Number(item.available),
        velocityPerMin: velocity,
        buffer: item.buffer,
        cap: item.cap,
      });

      if (publishQty === Number(item.last_pushed_qty)) {
        await this.updatePushedVersionOnly(Channel.FLIPKART, item.sku, Number(item.version));
        continue;
      }

      toPush.push({ item, publishQty });
    }

    while (toPush.length > 0 && this.flipkartTokens > 0) {
      this.flipkartTokens--;
      const batch = toPush.splice(0, 50);

      const updates = batch.map((b) => ({
        sku: b.item.sku,
        qty: b.publishQty,
        version: Number(b.item.version),
      }));

      await this.sendToFlipkart(updates);

      for (const u of updates) {
        await this.recordPushSuccess(Channel.FLIPKART, u.sku, u.qty, u.version);
      }
    }
  }

  private async fetchDirtySkus(channel: Channel): Promise<DirtySkuRow[]> {
    return this.dataSource.query(
      `SELECT cs.sku, (i.on_hand - i.reserved) AS available, i.version, 
              cs.last_pushed_qty, cs.buffer, cs.cap, i.updated_at
       FROM channel_stock cs 
       JOIN inventory i USING (sku)
       WHERE cs.channel = $1 AND i.version > cs.pushed_version
       LIMIT 500;`,
      [channel],
    );
  }

  /**
   * Priority Ordering:
   * 1. Going to 0 first (publishQty === 0 or available <= 0)
   * 2. At or below channel threshold
   * 3. Oldest change (updated_at ASC)
   */
  private prioritizeSkus(
    channel: Channel,
    skus: DirtySkuRow[],
    velocities: Map<string, number>,
  ): DirtySkuRow[] {
    const blindWindow = DEFAULT_BLIND_WINDOWS[channel] ?? 60;
    const floor = DEFAULT_FLOORS[channel] ?? 0;

    return skus.sort((a, b) => {
      const aAvail = Number(a.available);
      const bAvail = Number(b.available);

      const aVel = (velocities.get(a.sku) ?? 0) / 60;
      const bVel = (velocities.get(b.sku) ?? 0) / 60;

      const aThreshold = Math.max(floor, Math.ceil(aVel * blindWindow * 1.5));
      const bThreshold = Math.max(floor, Math.ceil(bVel * blindWindow * 1.5));

      const aGoingToZero = aAvail <= 0 || aAvail <= (a.buffer || 0);
      const bGoingToZero = bAvail <= 0 || bAvail <= (b.buffer || 0);

      // 1. Going to 0 first
      if (aGoingToZero && !bGoingToZero) return -1;
      if (!aGoingToZero && bGoingToZero) return 1;

      // 2. At or below threshold
      const aBelowThreshold = aAvail <= aThreshold;
      const bBelowThreshold = bAvail <= bThreshold;
      if (aBelowThreshold && !bBelowThreshold) return -1;
      if (!aBelowThreshold && bBelowThreshold) return 1;

      // 3. Oldest change first (updated_at ASC)
      return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    });
  }

  private async updatePushedVersionOnly(
    channel: Channel,
    sku: string,
    inventoryVersion: number,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE channel_stock 
       SET pushed_version = $1, updated_at = NOW()
       WHERE channel = $2 AND sku = $3;`,
      [inventoryVersion, channel, sku],
    );
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

  // Simulated channel API calls
  private async sendToWebsite(sku: string, qty: number): Promise<void> {
    // Simulated internal cache / API call
  }

  private async sendToNykaa(sku: string, qty: number): Promise<void> {
    // Simulated Nykaa REST API call (1 SKU/call)
  }

  private async sendToBlinkit(sku: string, qty: number): Promise<void> {
    // Simulated Blinkit REST API call (1 SKU/call)
  }

  private async sendToFlipkart(updates: { sku: string; qty: number }[]): Promise<void> {
    // Simulated Flipkart Bulk API call (up to 50 SKUs/call)
  }
}
