import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { SyncJobStatus } from '../common/enums';
import { SyncJob } from '../database/entities/sync-job.entity';

@Injectable()
export class ErpService {
  private readonly logger = new Logger(ErpService.name);
  private circuitBreakerOpen = false;
  private consecutiveFailures = 0;
  private isDraining = false;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * ERP Outbox Drain Worker
   * Runs every 3 seconds to claim pending outbox jobs using FOR UPDATE SKIP LOCKED.
   */
  @Interval(3000)
  async drainOutbox(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    try {
      // 1. Claim up to 10 jobs safely with SKIP LOCKED and per-order FIFO guarantee
      const claimedJobs: SyncJob[] = await this.dataSource.query(`
        WITH next AS (
          SELECT id FROM sync_jobs j
           WHERE j.status IN ('PENDING', 'RETRY') AND j.next_attempt_at <= NOW()
             AND NOT EXISTS (
               SELECT 1 FROM sync_jobs e
                WHERE e.aggregate_key = j.aggregate_key AND e.id < j.id
                  AND e.status NOT IN ('SUCCEEDED', 'DISCARDED')
             )
           ORDER BY j.id
           LIMIT 10
           FOR UPDATE SKIP LOCKED
        )
        UPDATE sync_jobs s
           SET status = 'RUNNING', 
               attempts = attempts + 1, 
               locked_until = NOW() + INTERVAL '5 minutes',
               updated_at = NOW()
          FROM next 
         WHERE s.id = next.id
        RETURNING s.*;
      `);

      if (!claimedJobs || claimedJobs.length === 0) {
        return;
      }

      for (const job of claimedJobs) {
        await this.processJob(job);
      }
    } catch (err) {
      this.logger.error('Error claiming ERP outbox jobs', err.stack);
    } finally {
      this.isDraining = false;
    }
  }

  private async processJob(job: SyncJob): Promise<void> {
    try {
      if (this.circuitBreakerOpen) {
        // Circuit open (e.g. Sunday maintenance); delay next retry
        await this.rescheduleJob(job.id, 'ERP maintenance circuit open (Sunday downtime)', 120);
        return;
      }

      // 2. Call Microsoft Business Central (Simulated)
      // Check idempotency via externalDocumentNumber before creating
      const bcDocNo = `BC-DOC-${job.payload.externalOrderId}`;

      // In production:
      // const existing = await bcClient.lookupByExternalDocNo(job.payload.externalOrderId);
      // if (existing) return markSucceeded(job.id, existing.no);
      // const res = await bcClient.createSalesOrder(job.payload);

      // Record success
      await this.dataSource.query(
        `UPDATE sync_jobs 
         SET status = $1, last_error = NULL, locked_until = NULL, updated_at = NOW()
         WHERE id = $2;`,
        [SyncJobStatus.SUCCEEDED, job.id],
      );

      // Update Order with ERP Doc No
      await this.dataSource.query(
        `UPDATE orders SET erp_doc_no = $1, updated_at = NOW() WHERE id = $2;`,
        [bcDocNo, job.payload.orderId],
      );

      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 5) {
        this.circuitBreakerOpen = true;
        this.logger.error('ERP circuit breaker OPENED. Pausing delivery for 2 minutes.');
        setTimeout(() => {
          this.circuitBreakerOpen = false;
          this.consecutiveFailures = 0;
          this.logger.log('ERP circuit breaker reset to HALF-OPEN for probe.');
        }, 120000);
      }

      const backoffSec = Math.min(Math.pow(2, job.attempts) * 10, 1800);
      if (job.attempts >= 10) {
        // Move to DEAD after 10 attempts
        await this.dataSource.query(
          `UPDATE sync_jobs SET status = $1, last_error = $2, locked_until = NULL WHERE id = $3;`,
          [SyncJobStatus.DEAD, err.message, job.id],
        );
      } else {
        await this.rescheduleJob(job.id, err.message, backoffSec);
      }
    }
  }

  private async rescheduleJob(jobId: string, errorMsg: string, delaySec: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE sync_jobs 
       SET status = $1, last_error = $2, next_attempt_at = NOW() + ($3 * INTERVAL '1 second'), locked_until = NULL, updated_at = NOW()
       WHERE id = $4;`,
      [SyncJobStatus.RETRY, errorMsg, delaySec, jobId],
    );
  }
}
