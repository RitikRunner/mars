import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('channel_push_log')
@Index(['channel', 'sku', 'created_at'])
export class ChannelPushLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 32 })
  channel: string;

  @Column({ type: 'varchar', length: 64 })
  sku: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ type: 'bigint' })
  inventory_version: number;

  @Column({ type: 'int' })
  http_status: number;

  @Column({ type: 'int' })
  latency_ms: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
