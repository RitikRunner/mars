import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { SyncJobStatus } from '../../common/enums';

@Entity('sync_jobs')
@Index(['status', 'next_attempt_at'])
export class SyncJob {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'varchar', length: 128 })
  aggregate_key: string;

  @Column({ type: 'varchar', length: 256, unique: true })
  idempotency_key: string;

  @Column({ type: 'jsonb' })
  payload: any;

  @Column({ type: 'varchar', length: 32, default: SyncJobStatus.PENDING })
  status: SyncJobStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  last_error: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  next_attempt_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  locked_until: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
