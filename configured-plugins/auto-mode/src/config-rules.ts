import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc } from "./jsonc.ts";
import { configDir } from "./paths.ts";
import { wildcard } from "./wildcard.ts";

export interface Rule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

function rulesIn(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (rule): rule is Rule =>
      typeof rule?.action === "string" && typeof rule?.resource === "string" && ["allow", "deny", "ask"].includes(rule?.effect),
  );
}

function read(file: string): Record<string, any> | undefined {
  try {
    const value = parseJsonc(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

function filesIn(dir: string): string[] {
  return ["opencode.json", "opencode.jsonc"].map((name) => join(dir, name)).filter(existsSync);
}

/**
 * Config files in OpenCode's precedence order: global, then direct
 * `opencode.json(c)` files from the farthest ancestor to the directory, then
 * `.opencode/opencode.json(c)` in the same order.
 */
export function configFiles(directory: string | undefined): string[] {
  const files = filesIn(configDir());
  if (!directory) return files;
  const ancestors: string[] = [];
  for (let dir = directory; ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const global = configDir();
  for (const dir of ancestors) if (dir !== global) files.push(...filesIn(dir));
  for (const dir of ancestors) {
    const nested = join(dir, ".opencode");
    if (nested !== global) files.push(...filesIn(nested));
  }
  return [...new Set(files)];
}

/** Every configured permission rule that applies to the agent, in evaluation order. */
export function configuredRules(directory: string | undefined, agent: string | undefined): Rule[] {
  const rules: Rule[] = [];
  const agentRules: Rule[] = [];
  for (const file of configFiles(directory)) {
    const config = read(file);
    if (!config) continue;
    rules.push(...rulesIn(config.permissions));
    if (agent) agentRules.push(...rulesIn(config.agents?.[agent]?.permissions));
  }
  return [...rules, ...agentRules];
}

/**
 * True when the user wrote a rule for this specific tool or command, so
 * OpenCode's own decision should stand. A catch-all `*` action rule does not
 * count: that is exactly the space auto mode reviews.
 */
export function userDecides(rules: readonly Rule[], action: string, resources: readonly string[]): boolean {
  if (resources.length === 0) return false;
  const deciding = resources.map((resource) =>
    rules.findLast((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource)),
  );
  const specific = (rule: Rule | undefined) => rule !== undefined && rule.action !== "*";
  // A specific ask or deny anywhere means OpenCode must ask (or block) anyway.
  if (deciding.some((rule) => specific(rule) && rule!.effect !== "allow")) return true;
  return deciding.every(specific);
}
