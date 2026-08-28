/** Counting semaphore used to bound image API and local post-process concurrency. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
  }

  get running(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new DOMException("aborted before acquire", "AbortError");
    }
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new DOMException("aborted while waiting for semaphore", "AbortError"));
      };
      const entry = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(() => this.release());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Run fn under the semaphore, releasing on settle. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Exponential backoff helper. Returns delay ms for attempt (1-based). */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("sleep aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
