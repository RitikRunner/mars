import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Channel } from '../common/enums';
import { UnifiedOrderDto } from '../common/dto';

@Injectable()
export class FlipkartPoller {
  private readonly logger = new Logger(FlipkartPoller.name);
  private lastWatermark: Date = new Date(Date.now() - 3600 * 1000); // 1 hour ago initially
  private isPolling = false;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Flipkart Polling Service
   * Runs every 2 minutes (120,000ms).
   * Fetches orders modified since `watermark - 10 minutes` to handle late writes.
   * Only inserts raw events into inbound_events; EventProcessorService claims and applies them.
   */
  @Interval(120000)
  async pollFlipkartOrders(): Promise<void> {
    if (this.isPolling) {
      this.logger.warn('Flipkart poll already running. Skipping overlap.');
      return;
    }

    this.isPolling = true;
    const fetchWindowStart = new Date(this.lastWatermark.getTime() - 10 * 60 * 1000);
    this.logger.log(`Polling Flipkart orders modified after ${fetchWindowStart.toISOString()}`);

    try {
      // In production: Call Flipkart Orders REST API with modifiedAfter filter
      const orders = await this.fetchMockFlipkartOrders(fetchWindowStart);

      for (const order of orders) {
        const dedupeKey = `${order.external_order_id}:${order.event}`;

        // Raw event ingestion only
        await this.dataSource.query(
          `INSERT INTO inbound_events (channel, dedupe_key, external_order_id, event_type, payload, status)
           VALUES ($1, $2, $3, $4, $5, 'RECEIVED')
           ON CONFLICT (channel, dedupe_key) DO NOTHING;`,
          [Channel.FLIPKART, dedupeKey, order.external_order_id, order.event, JSON.stringify(order)],
        );
      }

      this.lastWatermark = new Date();
    } catch (err) {
      this.logger.error('Error during Flipkart order poll', err.stack);
    } finally {
      this.isPolling = false;
    }
  }

  private async fetchMockFlipkartOrders(since: Date): Promise<UnifiedOrderDto[]> {
    // Returns empty array during normal idle; mock generator can inject orders here
    return [];
  }
}
