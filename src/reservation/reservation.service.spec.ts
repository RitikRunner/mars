import { ReservationService } from './reservation.service';
import { Channel, OrderStatus, LineStatus } from '../common/enums';
import { UnifiedOrderDto } from '../common/dto';

describe('ReservationService - Concurrency & Invariant Tests', () => {
  let service: ReservationService;
  let mockQueryRunner: any;
  let mockDataSource: any;

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

    mockDataSource = {
      createQueryRunner: jest.fn(() => mockQueryRunner),
    };

    service = new ReservationService(mockDataSource);
  });

  it('should successfully reserve stock when sufficient inventory is available', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue(null); // No existing order
    // Simulate successful conditional update returning on_hand=10, reserved=1
    mockQueryRunner.manager.query.mockResolvedValue([{ on_hand: 10, reserved: 1, version: 2 }]);

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
    // Simulate conditional update returning 0 rows (condition failed)
    mockQueryRunner.manager.query.mockResolvedValue([]);

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
    // 0 rows updated
    mockQueryRunner.manager.query.mockResolvedValue([]);

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
    // Existing cancelled order
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
    expect(mockQueryRunner.manager.query).not.toHaveBeenCalled(); // No stock touched!
  });
});
