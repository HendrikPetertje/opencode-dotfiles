import { stripAssignments, words } from "./shell.ts";
import { wildcard } from "./wildcard.ts";

/** What the user picked for a call in the modal, for the rest of the session. */
export type Override = "deny" | "check" | "allow" | "alike";
export const OVERRIDES: readonly Override[] = ["deny", "check", "allow", "alike"];

export function cycle(current: Override, step: -1 | 1): Override {
  const index = OVERRIDES.indexOf(current) + step;
  return OVERRIDES[Math.max(0, Math.min(OVERRIDES.length - 1, index))]!;
}

/** Identifies one exact call: the action plus its full command or resources. */
export function exactKey(action: string, subject: string): string {
  return `${action}\u0000${subject}`;
}

export interface AlikeRule {
  action: string;
  pattern: string;
}

/**
 * The "allow alike" pattern for a call: program plus subcommand for shell
 * (`npm test --watch` -> `npm test *`), the origin for web fetches, and the
 * whole tool for everything else (MCP tools, subagents, ...).
 */
export function alikeRule(action: string, resources: readonly string[]): AlikeRule {
  if (action === "shell") {
    const tokens = stripAssignments(words(resources[0] ?? ""));
    const [program = "*", sub] = tokens;
    const pattern = sub && /^[a-z][\w:.-]*$/.test(sub) ? `${program} ${sub} *` : `${program} *`;
    return { action, pattern };
  }
  if (action === "webfetch") {
    try {
      return { action, pattern: `${new URL(resources[0] ?? "").origin}/*` };
    } catch {}
  }
  if (action === "edit" || action === "write" || action === "patch") {
    const first = resources[0] ?? "";
    const dir = first.includes("/") ? first.slice(0, first.lastIndexOf("/")) : "";
    return { action, pattern: dir ? `${dir}/*` : "*" };
  }
  return { action, pattern: "*" };
}

/** `npm test *` also matches a bare `npm test`. */
export function matchesAlike(rule: AlikeRule, action: string, resources: readonly string[]): boolean {
  if (rule.action !== action || resources.length === 0) return false;
  return resources.every(
    (resource) =>
      wildcard(resource, rule.pattern) || (rule.pattern.endsWith(" *") && resource === rule.pattern.slice(0, -2)),
  );
}

/** Each shell segment needs its own alike rule; one `npm test *` must not cover `npm test && curl ...`. */
export function alikeRulesFor(action: string, resources: readonly string[]): AlikeRule[] {
  if (action !== "shell") return [alikeRule(action, resources)];
  return resources.map((resource) => alikeRule(action, [resource]));
}

export function coveredByAlike(rules: readonly AlikeRule[], action: string, resources: readonly string[]): boolean {
  if (resources.length === 0) return false;
  if (action !== "shell") return rules.some((rule) => matchesAlike(rule, action, resources));
  return resources.every((resource) => rules.some((rule) => matchesAlike(rule, action, [resource])));
}
