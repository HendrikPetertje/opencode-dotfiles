/** Reviewed calls that stay on guard after a deny. */
export const GUARD_REVIEWS = 10;
/** Recent denials shown to the reviewer while on guard. */
const MAX_RECENT = 3;

export interface Denial {
  subject: string;
  reason: string;
}

/**
 * Heightened review after a deny: no quick-check shortcut, no "allowed this
 * before" cache, and the reviewer is shown what was denied so it can spot
 * workarounds. Lasts `GUARD_REVIEWS` reviewed calls; every deny resets it.
 */
export interface Guard {
  remaining: number;
  recent: Denial[];
}

export const idleGuard = (): Guard => ({ remaining: 0, recent: [] });

export function onDeny(guard: Guard, denial: Denial): Guard {
  return { remaining: GUARD_REVIEWS, recent: [...guard.recent, denial].slice(-MAX_RECENT) };
}

/** Uses up one reviewed call. Denials are forgotten once the guard runs out. */
export function onReview(guard: Guard): Guard {
  if (guard.remaining <= 0) return guard;
  const remaining = guard.remaining - 1;
  return remaining === 0 ? idleGuard() : { ...guard, remaining };
}

export const onGuard = (guard: Guard | undefined) => (guard?.remaining ?? 0) > 0;
