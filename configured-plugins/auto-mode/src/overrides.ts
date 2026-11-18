/**
 * What the user picked for a call, for the rest of the session:
 * - `deny`: this exact call is denied
 * - `check`: this exact call always goes to review
 * - `allow`: the whole tool is allowed whatever its input; for `NO_ALWAYS`
 *   tools, calls alike to this one are allowed instead (the reviewer judges)
 *
 * "Always allow" on OpenCode's permission prompt does the same as `allow`.
 */
export type Override = "deny" | "check" | "allow";
export const OVERRIDES: readonly Override[] = ["deny", "check", "allow"];

export function cycle(current: Override, step: -1 | 1): Override {
  const from = OVERRIDES.indexOf(current);
  const index = (from === -1 ? OVERRIDES.indexOf("check") : from) + step;
  return OVERRIDES[Math.max(0, Math.min(OVERRIDES.length - 1, index))]!;
}

/** Identifies one exact call: the action plus its full command or resources. */
export function exactKey(action: string, subject: string): string {
  return `${action}\u0000${subject}`;
}

/** Tools whose input decides everything: "allow" on these becomes an alike rule the reviewer checks. */
export const NO_ALWAYS = new Set(["shell", "execute", "webfetch", "read", "grep", "glob"]);

/** An "allow" on a `NO_ALWAYS` tool: the call it was given on, and what the user was asking for then. */
export interface AlikeEntry {
  action: string;
  subject: string;
  /** The user's latest message at that moment: the goal later calls are compared against. */
  goal?: string;
}

/** What one session allows: whole tools, and reviewer-checked alike calls. */
export interface SessionAllows {
  always: string[];
  alikes: AlikeEntry[];
}

/** Adds the rule an "allow" on this call creates. */
export function addAllow(allows: SessionAllows, action: string, subject: string, goal?: string): void {
  if (NO_ALWAYS.has(action)) {
    if (!allows.alikes.some((entry) => entry.action === action && entry.subject === subject)) {
      allows.alikes.push({ action, subject, goal });
    }
  } else if (!allows.always.includes(action)) {
    allows.always.push(action);
  }
}

/** Removes the rule an "allow" on this call created. */
export function removeAllow(allows: SessionAllows, action: string, subject: string): void {
  if (NO_ALWAYS.has(action)) {
    allows.alikes = allows.alikes.filter((entry) => !(entry.action === action && entry.subject === subject));
  } else {
    allows.always = allows.always.filter((tool) => tool !== action);
  }
}
