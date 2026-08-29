import { randomUUID } from "node:crypto";
import type { JobRepo } from "@aai/storage";
import { logger } from "./logger";

export interface JobHandlerContext {
  jobId: string;
  runId: string | null;
  /** 长任务应周期性检查取消并上报进度 */
  signal: AbortSignal;
  onProgress: () => void;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;

export interface JobRunnerOptions {
  holder?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  /** 看门狗检查周期 */
  watchdogIntervalMs?: number;
  /** running 任务多久无进展视为停滞 */
  stallTimeoutMs?: number;
  /** 同时执行的 handler 数上限（阶段 0 默认 1） */
  maxConcurrent?: number;
}

interface RunningEntry {
  jobId: string;
  controller: AbortController;
}

/**
 * 进程内 Job Runner：
 * - 从 SQLite jobs 表认领任务（queued / retry_waiting / 租约过期的 running）；
 * - 心跳续租 + 看门狗回收停滞任务（先持久化终态，再取消执行）；
 * - 启动时强制回收遗留 running 任务（阶段 0 单实例部署假设）；
 * - 状态转换由 JobRepo 保证：终态不可覆盖。
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Map<string, RunningEntry>();
  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  readonly holder: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly stallTimeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(
    private readonly jobRepo: JobRepo,
    options: JobRunnerOptions = {},
  ) {
    this.holder = options.holder ?? `runner-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 30_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 2_100_000;
    this.maxConcurrent = options.maxConcurrent ?? 1;
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recoverOrphans();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.watchdogTimer = setInterval(() => this.runWatchdog(), this.watchdogIntervalMs);
    logger.info("job runner started", { holder: this.holder, maxConcurrent: this.maxConcurrent });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.timer = null;
    this.watchdogTimer = null;
    // 等待在途 handler 结束（不强制杀任务；下一次启动会按恢复语义重跑）
    const deadline = Date.now() + 10_000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    logger.info("job runner stopped", { holder: this.holder });
  }

  /** 阶段 0 单实例：启动时把遗留 running 释放回队列，claim 时计入 recoveries */
  recoverOrphans(): number {
    const orphans = this.jobRepo.listByStatus(["running"]);
    let count = 0;
    for (const job of orphans) {
      this.jobRepo.updateStatus(job.id, "queued");
      this.jobRepo.appendEvent(job.id, "orphan_recovered", "released stale running lease on boot");
      count += 1;
    }
    if (count > 0) logger.info("recovered orphan jobs", { count });
    return count;
  }

  cancel(jobId: string): boolean {
    const entry = this.running.get(jobId);
    const job = this.jobRepo.updateStatus(jobId, "cancelled");
    this.jobRepo.appendEvent(jobId, "cancelled", "by user");
    if (entry) entry.controller.abort();
    return job.status === "cancelled";
  }

  private runWatchdog(): void {
    try {
      const stalled = this.jobRepo.failStalled(this.stallTimeoutMs);
      for (const job of stalled) {
        const entry = this.running.get(job.id);
        entry?.controller.abort();
        logger.warn("stalled job recycled", { jobId: job.id });
      }
    } catch (error) {
      logger.error("watchdog failed", { error: String(error) });
    }
  }

  private async tick(): Promise<void> {
    if (this.running.size >= this.maxConcurrent) return;
    const job = this.jobRepo.claimNext(this.holder, this.leaseMs);
    if (!job) return;
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      this.jobRepo.updateStatus(job.id, "failed", { lastError: `no handler for kind ${job.kind}` });
      return;
    }

    const controller = new AbortController();
    this.running.set(job.id, { jobId: job.id, controller });
    void this.execute(job.id, job.runId, handler, controller).finally(() => {
      this.running.delete(job.id);
    });
  }

  private async execute(
    jobId: string,
    runId: string | null,
    handler: JobHandler,
    controller: AbortController,
  ): Promise<void> {
    // 心跳续租是 Runner 的职责：慢调用（分钟级推理）期间租约绝不意外过期，
    // 否则其他 runner 实例会把任务误判为孤儿并重复执行
    const heartbeat = setInterval(() => {
      try {
        this.jobRepo.renewLease(jobId, this.holder, this.leaseMs);
      } catch {
        /* 下一轮心跳重试 */
      }
    }, Math.max(5_000, Math.floor(this.leaseMs / 3)));

    try {
      await handler({
        jobId,
        runId,
        signal: controller.signal,
        onProgress: () => this.jobRepo.renewLease(jobId, this.holder, this.leaseMs),
      });
      this.jobRepo.updateStatus(jobId, "succeeded");
      this.jobRepo.appendEvent(jobId, "succeeded");
    } catch (error) {
      const job = this.jobRepo.require(jobId);
      const message = error instanceof Error ? error.message : String(error);
      // 用户取消：终态已在 cancel() 中写入，这里不覆盖
      if (controller.signal.aborted && job.status === "cancelled") return;
      const retry = job.attempts < job.maxAttempts;
      this.jobRepo.updateStatus(jobId, retry ? "retry_waiting" : "failed", { lastError: message.slice(0, 500) });
      this.jobRepo.appendEvent(jobId, retry ? "retry_scheduled" : "failed", message.slice(0, 500));
      logger.error("job failed", { jobId, retry, error: message.slice(0, 500) });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
