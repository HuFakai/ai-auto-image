/**
 * 简单信号量：限制并发进入临界区。
 * 图片 API 调用与 Sharp 后处理各用一个，429 降级时直接调低 limit。
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private limit: number) {
    if (limit < 1) throw new Error("semaphore limit must be >= 1");
  }

  get limitValue(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.active;
  }

  /** 收紧并发上限（429 自动降级）；只允许降低，不自动回升 */
  tighten(newLimit: number): void {
    if (newLimit < 1) newLimit = 1;
    if (newLimit < this.limit) this.limit = newLimit;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
