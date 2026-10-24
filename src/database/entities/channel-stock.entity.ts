import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('channel_stock')
export class ChannelStock {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  channel: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  sku: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  listing_id: string;

  @Column({ type: 'int', default: 0 })
  last_pushed_qty: number;

  @Column({ type: 'bigint', default: 0 })
  pushed_version: number;

  @Column({ type: 'int', default: 0 })
  buffer: number;

  @Column({ type: 'int', nullable: true })
  cap: number;

  @Column({ type: 'text', nullable: true })
  last_error: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
