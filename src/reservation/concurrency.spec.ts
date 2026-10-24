import { DataSource } from 'typeorm';
import { ReservationService } from './reservation.service';
import { Channel, OrderStatus, LineStatus } from '../common/enums';
import {
  Inventory,
  Order,
  OrderItem,
  StockLedger,
  ChannelStock,
  ChannelPushLog,
  SyncJob,
  InboundEvent,
} from '../database/entities';
import { UnifiedOrderDto } from '../common/dto';

describe('ReservationService - Real PostgreSQL Concurrency Integration Tests', () => {
  let dataSource: DataSource;
  let service: ReservationService;
  let dbAvailable = false;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'mars_user',
      password: process.env.DB_PASSWORD || 'mars_password',
      database: process.env.DB_NAME || 'mars_sync_db',
      entities: [
        Inventory,
        Order,
        OrderItem,
        StockLedger,
        ChannelStock,
        ChannelPushLog,
        SyncJob,
        InboundEvent,
      ],
      synchronize: false,
    });

    try {
      await dataSource.initialize();
      dbAvailable = true;
      service = new ReservationService(dataSource);
    } catch (err: any) {
      console.warn(
        `PostgreSQL unreachable at ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}. Skipping concurrency integration tests: ${err.message}`,
      );
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  // a) 20 concurrent marketplace orders for a SKU with on_hand = 5
  //    give exactly 5 RESERVED lines, 15 SHORT lines, and inventory.reserved = 5
  it('a) 20 concurrent marketplace orders for on_hand = 5 give exactly 5 RESERVED, 15 SHORT, reserved = 5', async () => {
    if (!dbAvailable) return;

    const testSku = 'CONCUR-TEST-A';
    await dataSource.query(
      `INSERT INTO inventory (sku, name, on_hand, reserved, version)
       VALUES ($1, 'Test SKU A', 5, 0, 1)
       ON CONFLICT (sku) DO UPDATE SET on_hand = 5, reserved = 0, version = 1;`,
      [testSku],
    );

    // Clean up previous test runs
    await dataSource.query(
      `DELETE FROM stock_ledger WHERE sku = $1;`,
      [testSku],
    );

    const orders: UnifiedOrderDto[] = Array.from({ length: 20 }, (_, i) => ({
      channel: Channel.NYKAA,
      external_order_id: `NYK-CONCUR-A-${Date.now()}-${i}`,
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: testSku, qty: 1, unit_price: 199 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 199,
    }));

    // Fire all 20 orders concurrently
    const results = await Promise.all(
      orders.map((order) => service.processOrderReservation(order)),
    );

    const reservedCount = results.filter(
      (r) => r.status === OrderStatus.RESERVED && !r.isShort,
    ).length;
    const shortCount = results.filter(
      (r) => r.status === OrderStatus.BACKORDERED && r.isShort,
    ).length;

    expect(reservedCount).toBe(5);
    expect(shortCount).toBe(15);

    // Verify database state
    const [invRows] = await dataSource.query(
      `SELECT on_hand, reserved FROM inventory WHERE sku = $1;`,
      [testSku],
    );
    expect(Number(invRows.reserved)).toBe(5);
  });

  // b) A website checkout and a Nykaa order for the last unit, at the same time,
  //    give exactly one RESERVED
  it('b) website checkout and Nykaa order for the last unit at the same time give exactly one RESERVED', async () => {
    if (!dbAvailable) return;

    const testSku = 'CONCUR-TEST-B';
    await dataSource.query(
      `INSERT INTO inventory (sku, name, on_hand, reserved, version)
       VALUES ($1, 'Test SKU B', 1, 0, 1)
       ON CONFLICT (sku) DO UPDATE SET on_hand = 1, reserved = 0, version = 1;`,
      [testSku],
    );

    await dataSource.query(`DELETE FROM stock_ledger WHERE sku = $1;`, [testSku]);

    const webOrder: UnifiedOrderDto = {
      channel: Channel.WEBSITE,
      external_order_id: `WEB-CONCUR-B-${Date.now()}`,
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: testSku, qty: 1, unit_price: 299 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 299,
    };

    const nykOrder: UnifiedOrderDto = {
      channel: Channel.NYKAA,
      external_order_id: `NYK-CONCUR-B-${Date.now()}`,
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: testSku, qty: 1, unit_price: 299 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 299,
    };

    const [resWeb, resNyk] = await Promise.all([
      service.processOrderReservation(webOrder),
      service.processOrderReservation(nykOrder),
    ]);

    const reservedCount = [resWeb, resNyk].filter(
      (r) => r.status === OrderStatus.RESERVED && !r.isShort,
    ).length;
    expect(reservedCount).toBe(1);

    const [invRows] = await dataSource.query(
      `SELECT on_hand, reserved FROM inventory WHERE sku = $1;`,
      [testSku],
    );
    expect(Number(invRows.reserved)).toBe(1);
  });

  // c) The same order processed 5 times concurrently gives exactly 1 order row,
  //    reserved increases once, and nothing throws
  it('c) same order processed 5 times concurrently gives exactly 1 order row, reserved increases once, nothing throws', async () => {
    if (!dbAvailable) return;

    const testSku = 'CONCUR-TEST-C';
    await dataSource.query(
      `INSERT INTO inventory (sku, name, on_hand, reserved, version)
       VALUES ($1, 'Test SKU C', 10, 0, 1)
       ON CONFLICT (sku) DO UPDATE SET on_hand = 10, reserved = 0, version = 1;`,
      [testSku],
    );

    const duplicateOrderId = `NYK-DUP-RACE-${Date.now()}`;
    const duplicateOrder: UnifiedOrderDto = {
      channel: Channel.NYKAA,
      external_order_id: duplicateOrderId,
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: testSku, qty: 2, unit_price: 150 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 300,
    };

    // Fire 5 identical requests concurrently
    const results = await Promise.all([
      service.processOrderReservation(duplicateOrder),
      service.processOrderReservation(duplicateOrder),
      service.processOrderReservation(duplicateOrder),
      service.processOrderReservation(duplicateOrder),
      service.processOrderReservation(duplicateOrder),
    ]);

    // Check none threw and all returned orderId
    for (const r of results) {
      expect(r.orderId).toBeDefined();
    }

    // Exactly 1 order in the database
    const orderRows = await dataSource.query(
      `SELECT id, status FROM orders WHERE channel = 'NYKAA' AND external_order_id = $1;`,
      [duplicateOrderId],
    );
    expect(orderRows.length).toBe(1);

    // Reserved increased only once (by 2, not by 10)
    const [invRows] = await dataSource.query(
      `SELECT on_hand, reserved FROM inventory WHERE sku = $1;`,
      [testSku],
    );
    expect(Number(invRows.reserved)).toBe(2);
  });

  // d) The sum of delta_reserved in stock_ledger for the SKU equals inventory.reserved
  it('d) sum of delta_reserved in stock_ledger equals inventory.reserved', async () => {
    if (!dbAvailable) return;

    const testSku = 'CONCUR-TEST-A'; // Reusing SKU A from test a)
    const [ledgerRows] = await dataSource.query(
      `SELECT COALESCE(SUM(delta_reserved), 0) AS sum_reserved FROM stock_ledger WHERE sku = $1;`,
      [testSku],
    );
    const [invRows] = await dataSource.query(
      `SELECT reserved FROM inventory WHERE sku = $1;`,
      [testSku],
    );

    expect(Number(ledgerRows.sum_reserved)).toBe(Number(invRows.reserved));
  });
});
