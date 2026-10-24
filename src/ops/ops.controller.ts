import { Controller, Get, Post, Param, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SyncJobStatus } from '../common/enums';

@Controller('ops')
export class OpsController {
  private readonly logger = new Logger(OpsController.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Functional Requirement 6:
   * "Give the ops team a screen that lists failed syncs and lets them retry each one."
   */
  @Get('failed-syncs')
  async getFailedSyncs() {
    const failedJobs = await this.dataSource.query(`
      SELECT id, type, aggregate_key, idempotency_key, status, attempts, last_error, next_attempt_at, updated_at
      FROM sync_jobs
      WHERE status IN ('DEAD', 'RETRY')
      ORDER BY updated_at DESC
      LIMIT 100;
    `);

    const failedEvents = await this.dataSource.query(`
      SELECT id, channel, dedupe_key, external_order_id, event_type, status, error, created_at
      FROM inbound_events
      WHERE status = 'FAILED'
      ORDER BY created_at DESC
      LIMIT 100;
    `);

    return {
      failedJobsCount: failedJobs.length,
      failedEventsCount: failedEvents.length,
      failedSyncJobs: failedJobs,
      failedInboundEvents: failedEvents,
    };
  }

  /**
   * One-click Retry endpoint for Ops Team
   */
  @Post('retry/:jobId')
  async retryFailedJob(@Param('jobId') jobId: string) {
    this.logger.log(`Ops triggered manual retry for job ${jobId}`);
    const result = await this.dataSource.query(
      `UPDATE sync_jobs 
       SET status = $1, next_attempt_at = NOW(), locked_until = NULL, updated_at = NOW()
       WHERE id = $2
       RETURNING id, status;`,
      [SyncJobStatus.PENDING, jobId],
    );

    return { success: true, updated: result };
  }

  /**
   * Audit Trail Requirement:
   * "For any SKU, ops must be able to answer: why did stock change, and when?"
   */
  @Get('sku-timeline/:sku')
  async getSkuAuditTimeline(@Param('sku') sku: string) {
    const inventory = await this.dataSource.query(
      `SELECT sku, name, on_hand, reserved, (on_hand - reserved) as available, version, updated_at 
       FROM inventory WHERE sku = $1;`,
      [sku],
    );

    const ledger = await this.dataSource.query(
      `SELECT id, delta_on_hand, delta_reserved, on_hand_after, reserved_after, available_after, 
              reason, ref_type, ref_id, channel, actor, created_at
       FROM stock_ledger
       WHERE sku = $1
       ORDER BY created_at DESC
       LIMIT 100;`,
      [sku],
    );

    const channelHistory = await this.dataSource.query(
      `SELECT channel, sku, qty, inventory_version, http_status, latency_ms, created_at
       FROM channel_push_log
       WHERE sku = $1
       ORDER BY created_at DESC
       LIMIT 50;`,
      [sku],
    );

    return {
      sku,
      currentInventory: inventory[0] || null,
      changeHistory: ledger,
      channelPushHistory: channelHistory,
    };
  }
}
