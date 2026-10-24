import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SyncJobStatus } from '../common/enums';
import { SyncJob } from '../database/entities/sync-job.entity';

@Injectable()
export class ErpService {
  private readonly logger = new Logger(ErpService.name);
  private circuitBreakerOpen = false;
  private consecutiveFailures = 0;
  private isDraining = false;
  private readonly erpApiUrl: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.erpApiUrl =
      this.configService.get<string>('ERP_API_URL') || 'http://localhost:3000/mock/erp';
  }

  /**
   * ERP Outbox Drain Worker (DESIGN.md §6)
   * Runs every 3 seconds to claim pending outbox jobs using FOR UPDATE SKIP LOCKED.
   */
  @Interval(3000)
  async drainOutbox(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    try {
      // 1. Lease recovery: reset stuck RUNNING jobs whose lease has expired
      await this.dataSource.query(`
        UPDATE sync_jobs 
        SET status = 'RETRY', locked_until = NULL, updated_at = NOW() 
        WHERE status = 'RUNNING' AND locked_until < NOW();
      `);

      // 2. Claim up to 10 jobs safely with SKIP LOCKED and per-order FIFO guarantee
      const [claimedJobs] = await this.dataSource.query(`
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
    } catch (err: any) {
      this.logger.error('Error claiming ERP outbox jobs', err.stack);
    } finally {
      this.isDraining = false;
    }
  }

  private async processJob(job: SyncJob): Promise<void> {
    const payload =
      typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    const externalDocNo = `${payload.channel}-${payload.externalOrderId}`;

    if (this.circuitBreakerOpen) {
      // While circuit is open, reschedule without counting attempt (undo the claim increment)
      await this.dataSource.query(
        `UPDATE sync_jobs 
         SET status = 'RETRY', 
             attempts = GREATEST(0, attempts - 1), 
             next_attempt_at = NOW() + INTERVAL '30 seconds', 
             locked_until = NULL, 
             updated_at = NOW() 
         WHERE id = $1;`,
        [job.id],
      );
      return;
    }

    try {
      if (job.type === 'ERP_CREATE') {
        // 1. Idempotent check: lookup by externalDocumentNumber
        const lookupRes = await fetch(
          `${this.erpApiUrl}/salesOrders?externalDocumentNumber=${encodeURIComponent(externalDocNo)}`,
          { signal: AbortSignal.timeout(30000) },
        );

        if (lookupRes.ok) {
          const data = (await lookupRes.json()) as any;
          await this.markJobSucceeded(job, data.no);
          return;
        }

        if (lookupRes.status === 404) {
          // Not created yet; create it
          const createRes = await fetch(`${this.erpApiUrl}/salesOrders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, externalDocumentNumber: externalDocNo }),
            signal: AbortSignal.timeout(30000),
          });

          if (createRes.ok) {
            const data = (await createRes.json()) as any;
            await this.markJobSucceeded(job, data.no);
            return;
          } else {
            await this.handleFailureResponse(job, createRes);
          }
        } else {
          await this.handleFailureResponse(job, lookupRes);
        }
      } else if (job.type === 'ERP_CANCEL') {
        const cancelRes = await fetch(
          `${this.erpApiUrl}/salesOrders/${encodeURIComponent(externalDocNo)}/cancel`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(30000),
          },
        );

        if (cancelRes.ok) {
          await this.dataSource.query(
            `UPDATE sync_jobs 
             SET status = $1, last_error = NULL, locked_until = NULL, updated_at = NOW()
             WHERE id = $2;`,
            [SyncJobStatus.SUCCEEDED, job.id],
          );
          this.consecutiveFailures = 0;
        } else {
          await this.handleFailureResponse(job, cancelRes);
        }
      }
    } catch (err: any) {
      await this.recordFailure(job, err.message || 'ERP Network Failure');
    }
  }

  private async markJobSucceeded(job: SyncJob, docNo: string): Promise<void> {
    const payload =
      typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

    await this.dataSource.query(
      `UPDATE sync_jobs 
       SET status = $1, last_error = NULL, locked_until = NULL, updated_at = NOW()
       WHERE id = $2;`,
      [SyncJobStatus.SUCCEEDED, job.id],
    );

    if (payload.orderId && docNo) {
      await this.dataSource.query(
        `UPDATE orders SET erp_doc_no = $1, updated_at = NOW() WHERE id = $2;`,
        [docNo, payload.orderId],
      );
    }

    this.consecutiveFailures = 0;
  }

  private async handleFailureResponse(job: SyncJob, res: Response): Promise<void> {
    const text = await res.text().catch(() => '');
    const errorMsg = `ERP returned HTTP ${res.status}: ${text}`;

    if (res.status >= 400 && res.status < 500) {
      // Non-retryable 4xx error: mark DEAD at once
      this.logger.error(`Non-retryable 4xx for job ${job.id}: ${errorMsg}`);
      await this.dataSource.query(
        `UPDATE sync_jobs 
         SET status = $1, last_error = $2, locked_until = NULL, updated_at = NOW() 
         WHERE id = $3;`,
        [SyncJobStatus.DEAD, errorMsg, job.id],
      );
    } else {
      // 5xx error (e.g. 503 maintenance)
      await this.recordFailure(job, errorMsg);
    }
  }

  private async recordFailure(job: SyncJob, errorMsg: string): Promise<void> {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 5 && !this.circuitBreakerOpen) {
      this.circuitBreakerOpen = true;
      this.logger.error('ERP circuit breaker OPENED for 2 minutes.');
      setTimeout(() => {
        this.circuitBreakerOpen = false;
        this.consecutiveFailures = 0;
        this.logger.log('ERP circuit breaker reset to HALF-OPEN for probe.');
      }, 120000);
    }

    // Check 24-hour expiration rule
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (ageMs > 24 * 3600 * 1000) {
      await this.dataSource.query(
        `UPDATE sync_jobs 
         SET status = $1, last_error = $2, locked_until = NULL, updated_at = NOW() 
         WHERE id = $3;`,
        [SyncJobStatus.DEAD, `Exceeded 24h retry window: ${errorMsg}`, job.id],
      );
      return;
    }

    // Exponential backoff with jitter
    const attempts = Math.max(0, job.attempts || 0);
    const baseSec = Math.min(Math.pow(2, attempts) * 10, 1800);
    const jitterSec = Math.floor(Math.random() * 5);
    const delaySec = isNaN(baseSec) ? 30 : baseSec + jitterSec;

    await this.dataSource.query(
      `UPDATE sync_jobs 
       SET status = $1, last_error = $2, next_attempt_at = NOW() + ($3 * INTERVAL '1 second'), locked_until = NULL, updated_at = NOW()
       WHERE id = $4;`,
      [SyncJobStatus.RETRY, errorMsg, delaySec, job.id],
    );
  }
}
