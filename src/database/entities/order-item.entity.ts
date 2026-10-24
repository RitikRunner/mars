import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
} from 'typeorm';
import { LineStatus } from '../../common/enums';
import { Order } from './order.entity';
import { Inventory } from './inventory.entity';

@Entity('order_items')
@Unique(['order', 'line_no'])
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ name: 'order_id', type: 'uuid' })
  order_id: string;

  @Column({ type: 'int' })
  line_no: number;

  @ManyToOne(() => Inventory)
  @JoinColumn({ name: 'sku' })
  inventory: Inventory;

  @Column({ type: 'varchar', length: 64 })
  sku: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  unit_price: number;

  @Column({ type: 'varchar', length: 32, default: LineStatus.RESERVED })
  line_status: LineStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
