/**
 * In-memory token-bucket rate limiter, keyed per shop.
 *
 * This protects the app (and the merchant's Shopify API budget) from runaway
 * clients. It is per-process; behind several instances each instance enforces
 * its own budget, which is still a hard upper bound.
 */

export interface RateLimiter {
  /** Consumes one token. Returns false when the caller is over the limit. */
  take(key: string): boolean;
  /** Seconds until one token is available again (0 if available now). */
  retryAfterSeconds(key: string): number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter(options: {
  capacity: number;
  refillPerMinute: number;
  now?: () => number;
  maxKeys?: number;
}): RateLimiter {
  const { capacity, refillPerMinute } = options;
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const perMs = refillPerMinute / 60_000;
  const buckets = new Map<string, Bucket>();

  const refill = (key: string): Bucket => {
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: t };
    bucket.tokens = Math.min(capacity, bucket.tokens + (t - bucket.updatedAt) * perMs);
    bucket.updatedAt = t;
    if (!buckets.has(key)) {
      if (buckets.size >= maxKeys) {
        // Drop the oldest entry; Map preserves insertion order.
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      buckets.set(key, bucket);
    }
    return bucket;
  };

  return {
    take(key) {
      const bucket = refill(key);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    retryAfterSeconds(key) {
      const bucket = refill(key);
      if (bucket.tokens >= 1) return 0;
      return Math.ceil((1 - bucket.tokens) / perMs / 1000);
    },
  };
}
