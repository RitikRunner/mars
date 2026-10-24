import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  Unique,
} from 'typeorm';
import { Channel, OrderStatus } from '../../common/enums';
import { OrderItem } from './order-item.entity';

@Entity('orders')
@Unique(['channel', 'external_order_id'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  channel: Channel;

  @Column({ type: 'varchar', length: 128 })
  external_order_id: string;

  @Column({ type: 'varchar', length: 32, default: OrderStatus.RECEIVED })
  status: OrderStatus;

  @Column({ type: 'varchar', length: 32 })
  payment_mode: string;

  @Column({ type: 'varchar', length: 10 })
  shipping_pincode: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  total_amount: number;

  @Column({ type: 'timestamptz', nullable: true })
  hold_expires_at: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  erp_doc_no: string;

  @Column({ type: 'timestamptz' })
  channel_event_time: Date;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
