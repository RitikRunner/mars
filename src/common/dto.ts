import {
  IsString,
  IsIn,
  IsISO8601,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  IsInt,
  Min,
  IsNumber,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Channel } from './enums';

export class OrderItemDto {
  @IsString()
  sku: string;

  @IsInt()
  @Min(1)
  qty: number;

  @IsNumber()
  unit_price: number;
}

export class UnifiedOrderDto {
  @IsOptional()
  @IsEnum(Channel)
  channel?: Channel;

  @IsString()
  external_order_id: string;

  @IsIn(['ORDER_CREATED', 'ORDER_CANCELLED'])
  event: 'ORDER_CREATED' | 'ORDER_CANCELLED';

  @IsISO8601()
  event_time: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsString()
  payment_mode: string;

  @IsString()
  shipping_pincode: string;

  @IsNumber()
  total_amount: number;
}
