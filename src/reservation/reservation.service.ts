import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { UnifiedOrderDto } from '../common/dto';
import {
  Channel,
  OrderStatus,
  LineStatus,
  AuditReason,
  SyncJobStatus,
} from '../common/enums';
import { Order } from '../database/entities/order.entity';
import { OrderItem } from '../database/entities/order-item.entity';
import { StockLedger } from '../database/entities/stock-ledger.entity';
import { SyncJob } from '../database/entities/sync-job.entity';

export interface ReservationResponse {
  orderId?: string;
  status: OrderStatus;
  lines: { sku: string; qty: number; status: LineStatus }[];
  isShort: boolean;
}

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Reserves stock for an incoming order within a single ACID transaction.
   *
   * 1. Checks for existing order (idempotency, out-of-order tombstone, or HELD confirmation).
   * 2. Sorts line items by SKU to prevent deadlocks across concurrent multi-SKU orders.
   * 3. Executes atomic conditional UPDATE for each line:
   *    UPDATE inventory SET reserved = reserved + :qty, version = version + 1
   *    WHERE sku = :sku AND on_hand - reserved >= :qty
   * 4. If any line fails:
   *    - WEBSITE: Rollback entire transaction (checkout gets 409 before payment).
   *    - MARKETPLACE: Line marked SHORT, order BACKORDERED, alert ops, no ERP job.
   * 5. Persists Order, OrderItems, StockLedger audit rows, and ERP SyncJob atomically.
   */
  async processOrderReservation(
    dto: UnifiedOrderDto,
    isHold = false,
  ): Promise<ReservationResponse> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Idempotency Check & Out-of-order Tombstone Handling
      const existing = await queryRunner.manager.findOne(Order, {
        where: { channel: dto.channel, external_order_id: dto.external_order_id },
        lock: { mode: 'pessimistic_write' },
      });

      if (existing) {
        // Out-of-order check: if already CANCELLED, late CREATED is a no-op
        if (existing.status === OrderStatus.CANCELLED) {
          this.logger.warn(
            `Order ${dto.external_order_id} on ${dto.channel} was already CANCELLED. Late CREATED ignored.`,
          );
          await queryRunner.rollbackTransaction();
          return {
            orderId: existing.id,
            status: OrderStatus.CANCELLED,
            lines: [],
            isShort: false,
          };
        }

        // Website Hold Confirmation: HELD order completed payment -> move to RESERVED & enqueue ERP
        if (existing.status === OrderStatus.HELD && dto.event === 'ORDER_CREATED') {
          existing.status = OrderStatus.RESERVED;
          existing.hold_expires_at = null;
          await queryRunner.manager.save(existing);

          // Enqueue ERP_CREATE job in same transaction
          await queryRunner.manager.insert(SyncJob, {
            type: 'ERP_CREATE',
            aggregate_key: `order:${existing.id}`,
            idempotency_key: `erp-create:${existing.id}`,
            payload: {
              orderId: existing.id,
              channel: existing.channel,
              externalOrderId: existing.external_order_id,
              totalAmount: existing.total_amount,
              pincode: existing.shipping_pincode,
              lines: dto.items.map((l) => ({ sku: l.sku, qty: l.qty, unitPrice: l.unit_price })),
            } as any,
            status: SyncJobStatus.PENDING,
            attempts: 0,
          });

          await queryRunner.commitTransaction();
          return {
            orderId: existing.id,
            status: OrderStatus.RESERVED,
            lines: [],
            isShort: false,
          };
        }

        // Duplicate replay
        await queryRunner.rollbackTransaction();
        return {
          orderId: existing.id,
          status: existing.status,
          lines: [],
          isShort: existing.status === OrderStatus.BACKORDERED,
        };
      }

      // Handle direct ORDER_CANCELLED arriving before ORDER_CREATED (Tombstone)
      if (dto.event === 'ORDER_CANCELLED') {
        const tombstone = queryRunner.manager.create(Order, {
          channel: dto.channel,
          external_order_id: dto.external_order_id,
          status: OrderStatus.CANCELLED,
          payment_mode: dto.payment_mode || 'UNKNOWN',
          shipping_pincode: dto.shipping_pincode || '000000',
          total_amount: dto.total_amount || 0,
          channel_event_time: new Date(dto.event_time),
        });
        await queryRunner.manager.save(tombstone);
        await queryRunner.commitTransaction();
        return {
          orderId: tombstone.id,
          status: OrderStatus.CANCELLED,
          lines: [],
          isShort: false,
        };
      }

      // 2. Sort lines by SKU to guarantee deadlock-free locking order
      const sortedLines = [...dto.items].sort((a, b) => a.sku.localeCompare(b.sku));
      const lineResults: { sku: string; qty: number; status: LineStatus; unitPrice: number }[] = [];
      let hasShortfall = false;

      // 3. Create initial order record (HELD if website hold, otherwise RECEIVED)
      const order = queryRunner.manager.create(Order, {
        channel: dto.channel,
        external_order_id: dto.external_order_id,
        status: isHold ? OrderStatus.HELD : OrderStatus.RECEIVED,
        hold_expires_at: isHold ? new Date(Date.now() + 15 * 60 * 1000) : null,
        payment_mode: dto.payment_mode,
        shipping_pincode: dto.shipping_pincode,
        total_amount: dto.total_amount,
        channel_event_time: new Date(dto.event_time),
      });
      const savedOrder = await queryRunner.manager.save(order);

      // 4. Reserve line by line
      for (let i = 0; i < sortedLines.length; i++) {
        const item = sortedLines[i];
        // Note: query() returns [rows, affectedCount] in TypeORM for UPDATE RETURNING
        const [rows] = await queryRunner.manager.query(
          `UPDATE inventory 
           SET reserved = reserved + $1, version = version + 1, updated_at = NOW()
           WHERE sku = $2 AND (on_hand - reserved) >= $1
           RETURNING on_hand, reserved, version;`,
          [item.qty, item.sku],
        );

        if (rows && rows.length > 0) {
          const { on_hand, reserved } = rows[0];
          lineResults.push({
            sku: item.sku,
            qty: item.qty,
            status: LineStatus.RESERVED,
            unitPrice: item.unit_price,
          });

          // Immutable audit ledger entry
          await queryRunner.manager.insert(StockLedger, {
            sku: item.sku,
            delta_on_hand: 0,
            delta_reserved: item.qty,
            on_hand_after: Number(on_hand),
            reserved_after: Number(reserved),
            available_after: Number(on_hand) - Number(reserved),
            reason: AuditReason.RESERVE,
            ref_type: 'ORDER_LINE',
            ref_id: `${savedOrder.id}:${i + 1}`,
            channel: dto.channel,
            actor: 'SYSTEM',
          });
        } else {
          // Stock unavailable
          if (dto.channel === Channel.WEBSITE) {
            // Website checkout is all-or-nothing: rollback and return immediately
            await queryRunner.rollbackTransaction();
            this.logger.warn(`Website order ${dto.external_order_id} failed: SKU ${item.sku} OUT_OF_STOCK`);
            return {
              status: isHold ? OrderStatus.HELD : OrderStatus.RECEIVED,
              lines: [{ sku: item.sku, qty: item.qty, status: LineStatus.SHORT }],
              isShort: true,
            };
          } else {
            // Marketplace order: customer already bought it on Nykaa/Flipkart/Blinkit
            hasShortfall = true;
            lineResults.push({
              sku: item.sku,
              qty: item.qty,
              status: LineStatus.SHORT,
              unitPrice: item.unit_price,
            });
            this.logger.error(
              `Marketplace SHORTFALL on ${dto.channel}: Order ${dto.external_order_id}, SKU ${item.sku}, Qty ${item.qty}`,
            );
          }
        }
      }

      // 5. Persist order items
      for (let i = 0; i < lineResults.length; i++) {
        const line = lineResults[i];
        const orderItem = queryRunner.manager.create(OrderItem, {
          order: savedOrder,
          order_id: savedOrder.id,
          line_no: i + 1,
          sku: line.sku,
          qty: line.qty,
          unit_price: line.unitPrice,
          line_status: line.status,
        });
        await queryRunner.manager.save(orderItem);
      }

      // 6. Finalize order status & outbound ERP sync job
      if (hasShortfall) {
        savedOrder.status = OrderStatus.BACKORDERED;
        await queryRunner.manager.save(savedOrder);
        // Do NOT enqueue ERP job for backordered orders until ops resolves/restocks
      } else if (isHold) {
        // Website hold: keep status HELD, do NOT enqueue ERP job
        savedOrder.status = OrderStatus.HELD;
        await queryRunner.manager.save(savedOrder);
      } else {
        savedOrder.status = OrderStatus.RESERVED;
        await queryRunner.manager.save(savedOrder);

        // Transactional Outbox: ERP create job commits inside same transaction
        await queryRunner.manager.insert(SyncJob, {
          type: 'ERP_CREATE',
          aggregate_key: `order:${savedOrder.id}`,
          idempotency_key: `erp-create:${savedOrder.id}`,
          payload: {
            orderId: savedOrder.id,
            channel: savedOrder.channel,
            externalOrderId: savedOrder.external_order_id,
            totalAmount: savedOrder.total_amount,
            pincode: savedOrder.shipping_pincode,
            lines: lineResults.map((l) => ({ sku: l.sku, qty: l.qty, unitPrice: l.unitPrice })),
          } as any,
          status: SyncJobStatus.PENDING,
          attempts: 0,
        });
      }

      await queryRunner.commitTransaction();

      return {
        orderId: savedOrder.id,
        status: savedOrder.status,
        lines: lineResults,
        isShort: hasShortfall,
      };
    } catch (err: any) {
      await queryRunner.rollbackTransaction();

      // Catch concurrent unique constraint violation (Postgres error code 23505)
      if (err.code === '23505' || err.driverError?.code === '23505') {
        const existing = await this.dataSource.getRepository(Order).findOne({
          where: { channel: dto.channel, external_order_id: dto.external_order_id },
        });
        if (existing) {
          return {
            orderId: existing.id,
            status: existing.status,
            lines: [],
            isShort: existing.status === OrderStatus.BACKORDERED,
          };
        }
      }

      this.logger.error(`Transaction failed for order ${dto.external_order_id}`, err.stack);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Releases reserved stock when an order is cancelled.
   * - Cancelling a HELD order releases stock with no ERP job.
   * - Cancelling a BACKORDERED order releases only its RESERVED lines (no ERP job).
   * - Cancelling a RESERVED order releases stock and enqueues ERP_CANCEL.
   */
  async cancelOrder(channel: Channel, externalOrderId: string): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { channel, external_order_id: externalOrderId },
        relations: ['items'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!order) {
        // Create tombstone so late CREATED event will be no-op
        const tombstone = queryRunner.manager.create(Order, {
          channel,
          external_order_id: externalOrderId,
          status: OrderStatus.CANCELLED,
          payment_mode: 'UNKNOWN',
          shipping_pincode: '000000',
          total_amount: 0,
          channel_event_time: new Date(),
        });
        await queryRunner.manager.save(tombstone);
        await queryRunner.commitTransaction();
        return true;
      }

      if (order.status === OrderStatus.CANCELLED) {
        await queryRunner.rollbackTransaction();
        return true;
      }

      const wasReserved = order.status === OrderStatus.RESERVED;

      // Reverse reserved lines (remove GREATEST(0, ...); check constraint reserved >= 0 is backstop)
      for (const item of order.items) {
        if (item.line_status === LineStatus.RESERVED) {
          const [rows] = await queryRunner.manager.query(
            `UPDATE inventory 
             SET reserved = reserved - $1, version = version + 1, updated_at = NOW()
             WHERE sku = $2
             RETURNING on_hand, reserved, version;`,
            [item.qty, item.sku],
          );

          if (rows && rows.length > 0) {
            const { on_hand, reserved } = rows[0];
            await queryRunner.manager.insert(StockLedger, {
              sku: item.sku,
              delta_on_hand: 0,
              delta_reserved: -item.qty,
              on_hand_after: Number(on_hand),
              reserved_after: Number(reserved),
              available_after: Number(on_hand) - Number(reserved),
              reason: AuditReason.CANCEL_RELEASE,
              ref_type: 'ORDER_LINE',
              ref_id: `${order.id}:${item.line_no}`,
              channel,
              actor: 'SYSTEM',
            });
          }
          item.line_status = LineStatus.RELEASED;
          await queryRunner.manager.save(item);
        }
      }

      order.status = OrderStatus.CANCELLED;
      await queryRunner.manager.save(order);

      // Only enqueue ERP_CANCEL if the order was fully RESERVED (ERP_CREATE exists)
      if (wasReserved) {
        await queryRunner.manager.insert(SyncJob, {
          type: 'ERP_CANCEL',
          aggregate_key: `order:${order.id}`,
          idempotency_key: `erp-cancel:${order.id}`,
          payload: {
            orderId: order.id,
            channel: order.channel,
            externalOrderId: order.external_order_id,
          } as any,
          status: SyncJobStatus.PENDING,
        });
      }

      await queryRunner.commitTransaction();
      return true;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Sweeper for expired website HELD orders.
   * Runs every 60 seconds. Releases stock and marks order CANCELLED with ledger HOLD_EXPIRED.
   */
  @Interval(60000)
  async sweepExpiredHolds(): Promise<void> {
    const expiredOrders = await this.dataSource.getRepository(Order).find({
      where: {
        status: OrderStatus.HELD,
      },
      relations: ['items'],
    });

    const now = new Date();
    for (const order of expiredOrders) {
      if (order.hold_expires_at && order.hold_expires_at < now) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
          for (const item of order.items) {
            if (item.line_status === LineStatus.RESERVED) {
              const [rows] = await queryRunner.manager.query(
                `UPDATE inventory 
                 SET reserved = reserved - $1, version = version + 1, updated_at = NOW()
                 WHERE sku = $2
                 RETURNING on_hand, reserved, version;`,
                [item.qty, item.sku],
              );

              if (rows && rows.length > 0) {
                const { on_hand, reserved } = rows[0];
                await queryRunner.manager.insert(StockLedger, {
                  sku: item.sku,
                  delta_on_hand: 0,
                  delta_reserved: -item.qty,
                  on_hand_after: Number(on_hand),
                  reserved_after: Number(reserved),
                  available_after: Number(on_hand) - Number(reserved),
                  reason: AuditReason.HOLD_EXPIRED,
                  ref_type: 'ORDER_LINE',
                  ref_id: `${order.id}:${item.line_no}`,
                  channel: order.channel,
                  actor: 'SYSTEM',
                });
              }
              item.line_status = LineStatus.RELEASED;
              await queryRunner.manager.save(item);
            }
          }

          order.status = OrderStatus.CANCELLED;
          await queryRunner.manager.save(order);
          await queryRunner.commitTransaction();
          this.logger.log(`Expired hold for order ${order.external_order_id} released`);
        } catch (err) {
          await queryRunner.rollbackTransaction();
          this.logger.error(`Failed to release expired hold on order ${order.id}`, err);
        } finally {
          await queryRunner.release();
        }
      }
    }
  }
}
