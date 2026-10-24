import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import {
  Inventory,
  Order,
  OrderItem,
  StockLedger,
  ChannelStock,
  ChannelPushLog,
  SyncJob,
  InboundEvent,
} from './database/entities';

import { ReservationService } from './reservation/reservation.service';
import { WebhookController } from './ingestion/webhook.controller';
import { FlipkartPoller } from './ingestion/flipkart.poller';
import { StockPushService } from './stock-push/stock-push.service';
import { ErpService } from './erp/erp.service';
import { OpsController } from './ops/ops.controller';
import { MockController } from './mock/mock.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'mars_user'),
        password: config.get<string>('DB_PASSWORD', 'mars_password'),
        database: config.get<string>('DB_NAME', 'mars_sync_db'),
        entities: [
          Inventory,
          Order,
          OrderItem,
          StockLedger,
          ChannelStock,
          ChannelPushLog,
          SyncJob,
          InboundEvent,
        ],
        synchronize: false, // In production, rely on migrations / init-db.sql
        logging: config.get<string>('NODE_ENV') === 'development' ? ['error', 'warn'] : false,
      }),
    }),
    TypeOrmModule.forFeature([
      Inventory,
      Order,
      OrderItem,
      StockLedger,
      ChannelStock,
      ChannelPushLog,
      SyncJob,
      InboundEvent,
    ]),
  ],
  controllers: [WebhookController, OpsController, MockController],
  providers: [
    ReservationService,
    FlipkartPoller,
    StockPushService,
    ErpService,
  ],
})
export class AppModule {}
