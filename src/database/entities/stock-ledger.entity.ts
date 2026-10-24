import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { AuditReason } from '../../common/enums';

@Entity('stock_ledger')
@Unique(['ref_type', 'ref_id', 'sku', 'reason'])
@Index(['sku', 'created_at'])
export class StockLedger {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  sku: string;

  @Column({ type: 'int', default: 0 })
  delta_on_hand: number;

  @Column({ type: 'int', default: 0 })
  delta_reserved: number;

  @Column({ type: 'int' })
  on_hand_after: number;

  @Column({ type: 'int' })
  reserved_after: number;

  @Column({ type: 'int' })
  available_after: number;

  @Column({ type: 'varchar', length: 64 })
  reason: AuditReason;

  @Column({ type: 'varchar', length: 64 })
  ref_type: string;

  @Column({ type: 'varchar', length: 128 })
  ref_id: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  channel: string;

  @Column({ type: 'varchar', length: 64, default: 'SYSTEM' })
  actor: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
