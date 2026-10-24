import { ReservationService } from './reservation.service';
import { Channel, OrderStatus, LineStatus } from '../common/enums';
import { UnifiedOrderDto } from '../common/dto';
import { Order } from '../database/entities/order.entity';

describe('ReservationService - Concurrency & Invariant Tests', () => {
  let service: ReservationService;
  let mockQueryRunner: any;
  let mockDataSource: any;
  let mockOrderRepo: any;

  beforeEach(() => {
    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(),
        create: jest.fn((entity, data) => ({ id: 'mock-order-id', ...data })),
        save: jest.fn((entity) => Promise.resolve(entity)),
        insert: jest.fn(() => Promise.resolve()),
        query: jest.fn(),
      },
    };

    mockOrderRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    mockDataSource = {
      createQueryRunner: jest.fn(() => mockQueryRunner),
      getRepository: jest.fn((entity) => {
        if (entity === Order) return mockOrderRepo;
        return {};
      }),
    };

    service = new ReservationService(mockDataSource);
  });

  it('should successfully reserve stock when sufficient inventory is available', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue(null);
    // Real TypeORM PostgreSQL return format for UPDATE RETURNING: [rows, count]
    mockQueryRunner.manager.query.mockResolvedValue([
      [{ on_hand: 10, reserved: 1, version: 2 }],
      1,
    ]);

    const orderDto: UnifiedOrderDto = {
      channel: Channel.WEBSITE,
      external_order_id: 'WEB-1001',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto);

    expect(res.status).toBe(OrderStatus.RESERVED);
    expect(res.isShort).toBe(false);
    expect(res.lines[0].status).toBe(LineStatus.RESERVED);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('should abort and rollback for Website checkout when out of stock', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue(null);
    // Real TypeORM return format when no row matched: [[], 0]
    mockQueryRunner.manager.query.mockResolvedValue([[], 0]);

    const orderDto: UnifiedOrderDto = {
      channel: Channel.WEBSITE,
      external_order_id: 'WEB-1002',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto);

    expect(res.isShort).toBe(true);
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('should mark line as SHORT and order as BACKORDERED for marketplace order when stock is 0', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue(null);
    mockQueryRunner.manager.query.mockResolvedValue([[], 0]);

    const orderDto: UnifiedOrderDto = {
      channel: Channel.NYKAA,
      external_order_id: 'NYK-9999',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto);

    expect(res.status).toBe(OrderStatus.BACKORDERED);
    expect(res.isShort).toBe(true);
    expect(res.lines[0].status).toBe(LineStatus.SHORT);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('should treat late ORDER_CREATED as no-op if order was already CANCELLED', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue({
      id: 'existing-id',
      status: OrderStatus.CANCELLED,
    });

    const orderDto: UnifiedOrderDto = {
      channel: Channel.NYKAA,
      external_order_id: 'NYK-8888',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto);

    expect(res.status).toBe(OrderStatus.CANCELLED);
    expect(mockQueryRunner.manager.query).not.toHaveBeenCalled();
  });

  // New test: HELD flow
  it('should place a 15-minute HELD reservation without creating an ERP job', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue(null);
    mockQueryRunner.manager.query.mockResolvedValue([
      [{ on_hand: 10, reserved: 1, version: 2 }],
      1,
    ]);

    const orderDto: UnifiedOrderDto = {
      channel: Channel.WEBSITE,
      external_order_id: 'WEB-HOLD-1',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto, true); // isHold = true

    expect(res.status).toBe(OrderStatus.HELD);
    expect(res.isShort).toBe(false);
    expect(mockQueryRunner.manager.insert).toHaveBeenCalledTimes(1); // StockLedger only, NO SyncJob!
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('should promote HELD order to RESERVED and enqueue ERP job when payment completes', async () => {
    const existingHeldOrder = {
      id: 'held-order-id',
      channel: Channel.WEBSITE,
      external_order_id: 'WEB-HOLD-1',
      status: OrderStatus.HELD,
      total_amount: 349,
      shipping_pincode: '110034',
    };
    mockQueryRunner.manager.findOne.mockResolvedValue(existingHeldOrder);

    const orderDto: UnifiedOrderDto = {
      channel: Channel.WEBSITE,
      external_order_id: 'WEB-HOLD-1',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto, false);

    expect(res.status).toBe(OrderStatus.RESERVED);
    expect(existingHeldOrder.status).toBe(OrderStatus.RESERVED);
    expect(mockQueryRunner.manager.insert).toHaveBeenCalled(); // SyncJob ERP_CREATE inserted!
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  // New test: 23505 duplicate handling
  it('should catch 23505 unique violation on concurrent insert and return existing order idempotently', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue(null);
    mockQueryRunner.manager.query.mockResolvedValue([
      [{ on_hand: 10, reserved: 1, version: 2 }],
      1,
    ]);

    // Simulate 23505 error on save
    const err: any = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    mockQueryRunner.manager.save.mockRejectedValue(err);

    // Repository finds existing order
    mockOrderRepo.findOne.mockResolvedValue({
      id: 'existing-id-23505',
      channel: Channel.NYKAA,
      external_order_id: 'NYK-DUP-1',
      status: OrderStatus.RESERVED,
    });

    const orderDto: UnifiedOrderDto = {
      channel: Channel.NYKAA,
      external_order_id: 'NYK-DUP-1',
      event: 'ORDER_CREATED',
      event_time: new Date().toISOString(),
      items: [{ sku: 'MRS-LIP-104', qty: 1, unit_price: 349 }],
      payment_mode: 'PREPAID',
      shipping_pincode: '110034',
      total_amount: 349,
    };

    const res = await service.processOrderReservation(orderDto);

    expect(res.orderId).toBe('existing-id-23505');
    expect(res.status).toBe(OrderStatus.RESERVED);
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  // New test: cancelling a HELD order
  it('should release stock when cancelling a HELD order without enqueuing ERP_CANCEL', async () => {
    const heldOrder = {
      id: 'held-order-id',
      channel: Channel.WEBSITE,
      external_order_id: 'WEB-HOLD-CANCEL',
      status: OrderStatus.HELD,
      items: [
        { sku: 'MRS-LIP-104', qty: 1, line_status: LineStatus.RESERVED, line_no: 1 },
      ],
    };
    mockQueryRunner.manager.findOne.mockResolvedValue(heldOrder);
    mockQueryRunner.manager.query.mockResolvedValue([
      [{ on_hand: 10, reserved: 0, version: 3 }],
      1,
    ]);

    const result = await service.cancelOrder(Channel.WEBSITE, 'WEB-HOLD-CANCEL');

    expect(result).toBe(true);
    expect(heldOrder.status).toBe(OrderStatus.CANCELLED);
    // Stock ledger should be inserted for release, but NO SyncJob for ERP_CANCEL
    expect(mockQueryRunner.manager.insert).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });
});
