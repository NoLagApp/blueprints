/**
 * CorrelationManager — maps correlationIds to pending promises with timeout.
 * Used by Handoff and Tools patterns for request/response correlation.
 */
export class CorrelationManager<T = unknown> {
  private _pending = new Map<
    string,
    {
      resolve: (value: T) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  /**
   * Register a pending correlation. Returns a promise that resolves
   * when `resolve()` is called with the matching correlationId.
   */
  register(correlationId: string, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this._pending.delete(correlationId);
          reject(
            new Error(
              `Correlation ${correlationId} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }

      this._pending.set(correlationId, { resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending correlation with a value.
   * Returns true if the correlationId was found and resolved.
   */
  resolve(correlationId: string, value: T): boolean {
    const entry = this._pending.get(correlationId);
    if (!entry) return false;

    if (entry.timer) clearTimeout(entry.timer);
    this._pending.delete(correlationId);
    entry.resolve(value);
    return true;
  }

  /**
   * Reject a pending correlation with an error.
   */
  reject(correlationId: string, error: Error): boolean {
    const entry = this._pending.get(correlationId);
    if (!entry) return false;

    if (entry.timer) clearTimeout(entry.timer);
    this._pending.delete(correlationId);
    entry.reject(error);
    return true;
  }

  /**
   * Check if a correlationId is pending.
   */
  has(correlationId: string): boolean {
    return this._pending.has(correlationId);
  }

  /**
   * Cancel all pending correlations.
   */
  clear(): void {
    for (const [id, entry] of this._pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`Correlation ${id} cancelled`));
    }
    this._pending.clear();
  }

  get size(): number {
    return this._pending.size;
  }
}
