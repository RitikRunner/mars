import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  HttpException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UnifiedOrderDto } from '../common/dto';
import { Channel, InboundStatus, OrderStatus } from '../common/enums';
import { InboundEvent } from '../database/entities/inbound-event.entity';
import { ReservationService } from '../reservation/reservation.service';

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reservationService: ReservationService,
  ) {}

  /**
   * Own Website Webhook (Direct DB / API)
   */
  @Post('website')
  @HttpCode(HttpStatus.OK)
  async handleWebsiteWebhook(@Body() payload: UnifiedOrderDto) {
    return this.ingestAndProcess(Channel.WEBSITE, payload);
  }

  /**
   * Nykaa Webhook
   * Quirks: May be sent twice or out of order.
   * Response must be under 2s to prevent Nykaa redelivery storms.
   */
  @Post('nykaa')
  @HttpCode(HttpStatus.OK)
  async handleNykaaWebhook(
    @Body() payload: UnifiedOrderDto,
    @Headers('x-nykaa-signature') signature?: string,
  ) {
    // In production: verifyHMAC(payload, signature, secret)
    return this.ingestAndProcess(Channel.NYKAA, payload);
  }

  /**
   * Blinkit Webhook
   */
  @Post('blinkit')
  @HttpCode(HttpStatus.OK)
  async handleBlinkitWebhook(@Body() payload: UnifiedOrderDto) {
    return this.ingestAndProcess(Channel.BLINKIT, payload);
  }

  /**
   * Synchronous Website Reservation API (Called before customer payment capture)
   */
  @Post('checkout/reserve')
  async handleCheckoutReserve(@Body() payload: UnifiedOrderDto) {
    const result = await this.reservationService.processOrderReservation({
      ...payload,
      channel: Channel.WEBSITE,
    });

    if (result.isShort) {
      throw new HttpException(
        { message: 'One or more items are out of stock', lines: result.lines },
        HttpStatus.CONFLICT,
      );
    }

    return {
      success: true,
      orderId: result.orderId,
      holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15-minute hold
    };
  }

  private async ingestAndProcess(channel: Channel, payload: UnifiedOrderDto) {
    const dedupeKey = `${payload.external_order_id}:${payload.event}`;

    // 1. Raw event insertion with ON CONFLICT DO NOTHING
    try {
      await this.dataSource.query(
        `INSERT INTO inbound_events (channel, dedupe_key, external_order_id, event_type, payload, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel, dedupe_key) DO NOTHING;`,
        [channel, dedupeKey, payload.external_order_id, payload.event, JSON.stringify(payload), InboundStatus.RECEIVED],
      );
    } catch (err) {
      this.logger.error(`Failed to record raw inbound event from ${channel}`, err.stack);
    }

    // 2. Delegate to reservation state machine
    if (payload.event === 'ORDER_CANCELLED') {
      await this.reservationService.cancelOrder(channel, payload.external_order_id);
    } else {
      await this.reservationService.processOrderReservation({
        ...payload,
        channel,
      });
    }

    return { received: true, external_order_id: payload.external_order_id };
  }
}
