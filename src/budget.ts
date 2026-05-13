/**
 * budget.ts — Daily request budget tracking for free-tier providers.
 *
 * Tracks rolling 24h request counts per provider. Providers with a
 * dailyRequestLimit are skipped when exhausted, preventing wasteful
 * API calls that would return 429s and consuming fallback slots.
 *
 * State is in-memory (resets on restart). A restart mid-day is acceptable —
 * the free tiers are generous enough that conservative under-counting is fine.
 */

interface ProviderUsage {
  timestamps: number[]; // epoch ms of each request
}

const usage: Map<string, ProviderUsage> = new Map();
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

/** Record a completed request for a provider. Call after successful dispatch. */
export function recordRequest(provider: string): void {
  const now = Date.now();
  if (!usage.has(provider)) usage.set(provider, { timestamps: [] });
  const entry = usage.get(provider)!;
  entry.timestamps.push(now);
  // Prune old entries outside the window
  const cutoff = now - WINDOW_MS;
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);
}

/** Returns count of requests in the last 24h for a provider. */
export function requestCount(provider: string): number {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const entry = usage.get(provider);
  if (!entry) return 0;
  return entry.timestamps.filter(t => t > cutoff).length;
}

/**
 * Returns true if provider is within its daily budget AND request size is within limit.
 * When false, the provider should be skipped in the chain.
 */
export function isProviderAvailable(
  provider: string,
  dailyLimit: number | undefined,
  maxChars: number | undefined,
  requestChars: number,
): boolean {
  // Size pre-check — skip before making network call
  if (maxChars !== undefined && requestChars > maxChars) {
    log('budget-skip-size', { provider, requestChars, maxChars });
    return false;
  }
  // Daily limit check
  if (dailyLimit !== undefined) {
    const used = requestCount(provider);
    if (used >= dailyLimit) {
      log('budget-exhausted', { provider, used, limit: dailyLimit });
      return false;
    }
  }
  return true;
}

/** Return current budget status for all tracked providers (for /status endpoint). */
export function budgetStatus(): Record<string, { used: number; limit?: number }> {
  const result: Record<string, { used: number; limit?: number }> = {};
  for (const [name, entry] of usage.entries()) {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    result[name] = { used: entry.timestamps.filter(t => t > cutoff).length };
  }
  return result;
}
