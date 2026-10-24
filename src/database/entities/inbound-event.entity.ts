import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { InboundStatus } from '../../common/enums';

@Entity('inbound_events')
@Unique(['channel', 'dedupe_key'])
export class InboundEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  channel: string;

  @Column({ type: 'varchar', length: 256 })
  dedupe_key: string;

  @Column({ type: 'varchar', length: 128 })
  external_order_id: string;

  @Column({ type: 'varchar', length: 64 })
  event_type: string;

  @Column({ type: 'jsonb' })
  payload: any;

  @Column({ type: 'varchar', length: 32, default: InboundStatus.RECEIVED })
  status: InboundStatus;

  @Column({ type: 'text', nullable: true })
  error: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
