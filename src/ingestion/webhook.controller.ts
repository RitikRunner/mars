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
import { Channel } from '../common/enums';
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
   * Asynchronous: stores raw event and returns 200 immediately.
   */
  @Post('website')
  @HttpCode(HttpStatus.OK)
  async handleWebsiteWebhook(@Body() payload: UnifiedOrderDto) {
    return this.ingestRawEvent(Channel.WEBSITE, payload);
  }

  /**
   * Nykaa Webhook
   * Asynchronous: stores raw event and returns 200 immediately (< 50ms).
   */
  @Post('nykaa')
  @HttpCode(HttpStatus.OK)
  async handleNykaaWebhook(
    @Body() payload: UnifiedOrderDto,
    @Headers('x-nykaa-signature') signature?: string,
  ) {
    return this.ingestRawEvent(Channel.NYKAA, payload);
  }

  /**
   * Blinkit Webhook
   * Asynchronous: stores raw event and returns 200 immediately.
   */
  @Post('blinkit')
  @HttpCode(HttpStatus.OK)
  async handleBlinkitWebhook(@Body() payload: UnifiedOrderDto) {
    return this.ingestRawEvent(Channel.BLINKIT, payload);
  }

  /**
   * Synchronous Website Reservation API (Called before customer payment capture)
   * Places a 15-minute HELD reservation on inventory. Does NOT enqueue ERP job.
   */
  @Post('checkout/reserve')
  async handleCheckoutReserve(@Body() payload: UnifiedOrderDto) {
    const result = await this.reservationService.processOrderReservation(
      {
        ...payload,
        channel: Channel.WEBSITE,
      },
      true, // isHold = true
    );

    if (result.isShort) {
      throw new HttpException(
        { message: 'One or more items are out of stock', lines: result.lines },
        HttpStatus.CONFLICT,
      );
    }

    return {
      success: true,
      orderId: result.orderId,
      holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  private async ingestRawEvent(channel: Channel, payload: UnifiedOrderDto) {
    const dedupeKey = `${payload.external_order_id}:${payload.event}`;

    // Raw event insertion with ON CONFLICT DO NOTHING
    // If this throws, NestJS returns HTTP 5xx so the channel retries
    await this.dataSource.query(
      `INSERT INTO inbound_events (channel, dedupe_key, external_order_id, event_type, payload, status)
       VALUES ($1, $2, $3, $4, $5, 'RECEIVED')
       ON CONFLICT (channel, dedupe_key) DO NOTHING;`,
      [
        channel,
        dedupeKey,
        payload.external_order_id,
        payload.event,
        JSON.stringify(payload),
      ],
    );

    return { received: true, external_order_id: payload.external_order_id };
  }
}
