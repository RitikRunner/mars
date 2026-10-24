import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { ReservationService } from '../reservation/reservation.service';
import { Channel } from '../common/enums';
import { UnifiedOrderDto } from '../common/dto';

@Injectable()
export class EventProcessorService {
  private readonly logger = new Logger(EventProcessorService.name);
  private isProcessing = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly reservationService: ReservationService,
  ) {}

  /**
   * Event Processor Worker (DESIGN.md §3)
   * Runs every 1 second. Claims up to 20 RECEIVED events using FOR UPDATE SKIP LOCKED.
   * Applies each event through ReservationService, marking as PROCESSED or FAILED.
   */
  @Interval(1000)
  async processInboundEvents(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Note: UPDATE ... RETURNING returns [rows, affectedCount] in TypeORM
      const [claimedEvents] = await this.dataSource.query(`
        UPDATE inbound_events
        SET status = 'PROCESSING', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM inbound_events
          WHERE status = 'RECEIVED'
          ORDER BY created_at ASC
          LIMIT 20
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `);

      if (!claimedEvents || claimedEvents.length === 0) {
        return;
      }

      for (const event of claimedEvents) {
        await this.handleSingleEvent(event);
      }
    } catch (err: any) {
      this.logger.error('Error claiming inbound events', err.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  private async handleSingleEvent(event: any): Promise<void> {
    try {
      const payload: UnifiedOrderDto =
        typeof event.payload === 'string'
          ? JSON.parse(event.payload)
          : event.payload;

      payload.channel = event.channel as Channel;

      if (event.event_type === 'ORDER_CANCELLED') {
        await this.reservationService.cancelOrder(
          event.channel as Channel,
          event.external_order_id,
        );
      } else {
        await this.reservationService.processOrderReservation(payload);
      }

      await this.dataSource.query(
        `UPDATE inbound_events SET status = 'PROCESSED', error = NULL, updated_at = NOW() WHERE id = $1;`,
        [event.id],
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to process inbound event ${event.id} (${event.external_order_id}): ${err.message}`,
      );
      await this.dataSource.query(
        `UPDATE inbound_events SET status = 'FAILED', error = $1, updated_at = NOW() WHERE id = $2;`,
        [err.message || 'Unknown processing error', event.id],
      );
    }
  }
}
