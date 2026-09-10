import type { Redis } from 'ioredis';

/**
 * How long a counter lives past its window, so a key cannot outlive its
 * meaning if a window is somehow reported as zero.
 */
const MINIMUM_TTL_SECONDS = 1;

interface RateLimitRule {
  readonly window: number;
  readonly max: number;
}

interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly retryAfter: number | null;
}

/** What the library asks of a store, and all it asks. */
export interface RateLimitStorage {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitVerdict>;
}

/**
 * Where the authentication library counts requests.
 *
 * Its own default is an in-process map. That is correct for one machine and
 * wrong for every deployment that runs more than one: each replica keeps its
 * own tally, so a limit of ten attempts becomes ten *per replica*, and a
 * restart forgives everything. The number that protects a sign-in form has to
 * be shared, which is what this is for.
 *
 * The same Redis the rate limiter and the queue use — the one configured never
 * to evict. A counter dropped under memory pressure is a limit that quietly
 * stops applying, which is worse than no limit at all because nothing reports
 * it.
 */
export function redisRateLimitStorage(redis: Redis): RateLimitStorage {
  return {
    async consume(key: string, rule: RateLimitRule): Promise<RateLimitVerdict> {
      const ttl = Math.max(Math.ceil(rule.window), MINIMUM_TTL_SECONDS);

      // INCR then EXPIRE, in one round trip. The expiry is set only on the
      // first hit, so the window is fixed from the first request rather than
      // sliding forward with every one — otherwise a caller who keeps trying
      // could hold the key alive forever and never be let back in.
      const [count] = (await redis
        .multi()
        .incr(key)
        .expire(key, ttl, 'NX')
        .exec()) as [[Error | null, number], [Error | null, number]];

      const hits = count[1];

      if (hits <= rule.max) {
        return { allowed: true, retryAfter: null };
      }

      const remaining = await redis.ttl(key);

      return {
        allowed: false,
        // A negative TTL means the key has no expiry, which should not happen;
        // reporting the whole window is the safe answer either way.
        retryAfter: remaining > 0 ? remaining : ttl,
      };
    },
  };
}
