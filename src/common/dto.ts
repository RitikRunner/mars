import { Channel } from './enums';

export class OrderItemDto {
  sku: string;
  qty: number;
  unit_price: number;
}

export class UnifiedOrderDto {
  channel: Channel;
  external_order_id: string;
  event: 'ORDER_CREATED' | 'ORDER_CANCELLED';
  event_time: string;
  items: OrderItemDto[];
  payment_mode: string;
  shipping_pincode: string;
  total_amount: number;
}
