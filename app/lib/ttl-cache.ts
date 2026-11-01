/**
 * Tiny per-key cache that also shares one in-flight call between concurrent callers.
 * Failures are never cached: the next caller retries.
 */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
}

export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now): TtlCache<T> {
  const entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
      const value = load();
      const entry = { expiresAt: now() + ttlMs, value };
      entries.set(key, entry);
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return value;
    },
    invalidate(key) {
      entries.delete(key);
    },
  };
}
