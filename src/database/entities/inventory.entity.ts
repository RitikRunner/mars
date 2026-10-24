import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('inventory')
export class Inventory {
  @PrimaryColumn({ length: 64 })
  sku: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'int', default: 0 })
  on_hand: number;

  @Column({ type: 'int', default: 0 })
  reserved: number;

  @Column({ type: 'bigint', default: 1 })
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  get available(): number {
    return this.on_hand - this.reserved;
  }
}
