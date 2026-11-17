/** Running reviewer cost for one root session. */
export interface CostTotal {
  usd: number;
  reviews: number;
  /** Reviews whose cost is unknown (the `generate.text` fallback reports none). */
  unpriced: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyCost = (): CostTotal => ({ usd: 0, reviews: 0, unpriced: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface CallUsage {
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

export function addUsage(total: CostTotal, usage: CallUsage | undefined): CostTotal {
  const next = { ...total, reviews: total.reviews + 1 };
  if (!usage || typeof usage.cost !== "number" || !Number.isFinite(usage.cost)) {
    next.unpriced += 1;
    return next;
  }
  next.usd += usage.cost;
  next.input += usage.tokens?.input ?? 0;
  next.output += (usage.tokens?.output ?? 0) + (usage.tokens?.reasoning ?? 0);
  next.cacheRead += usage.tokens?.cache?.read ?? 0;
  next.cacheWrite += usage.tokens?.cache?.write ?? 0;
  return next;
}

/** `$0.0042`, `$0.13`, `$2.40`; a trailing `+` when some reviews had no price. */
export function formatUsd(total: CostTotal): string {
  const digits = total.usd === 0 ? 2 : total.usd < 0.1 ? 4 : 2;
  return `$${total.usd.toFixed(digits)}${total.unpriced > 0 ? "+" : ""}`;
}

/**
 * Share of prompt tokens served from cache. Some providers count cached tokens
 * inside `input`, others separately; when `input` can't contain them, add them.
 */
export function cachedShare(total: CostTotal): number | undefined {
  const cached = total.cacheRead + total.cacheWrite;
  const prompt = total.input >= cached ? total.input : total.input + cached;
  return prompt > 0 ? total.cacheRead / prompt : undefined;
}
