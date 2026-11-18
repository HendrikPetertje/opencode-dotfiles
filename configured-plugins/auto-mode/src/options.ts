import { DEFAULT_ALIKE_TOOLS } from "./overrides.ts";

export interface ScopeToggle {
  global: boolean;
  project: boolean;
}

export interface PolicyOptions {
  trusted?: string[];
  blocks?: string[];
  exceptions?: string[];
}

export interface Options {
  model?: { providerID: string; id: string };
  /** Why the plugin cannot review, when the options are unusable. */
  problem?: string;
  enabled: boolean;
  yoloEdits: boolean;
  messages: number;
  includeAgentsMd: ScopeToggle;
  includeMemory: ScopeToggle;
  memoryDir: string;
  memoryFile: string;
  review: "all" | "prompts";
  log: boolean;
  keybind: string;
  policy: PolicyOptions;
  /** Tools where "allow" means "allow alike" (reviewer-checked) instead of the whole tool. */
  alikeTools: string[];
}

function toggle(value: unknown): ScopeToggle {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return { global: record.global !== false, project: record.project !== false };
  }
  return { global: value !== false, project: value !== false };
}

/** `"github-copilot/claude-haiku-5.5"` -> provider `github-copilot`, model `claude-haiku-5.5`. Model IDs may contain `/`. */
export function parseModel(value: unknown): { providerID: string; id: string } | undefined {
  if (typeof value !== "string") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerID: value.slice(0, slash).trim(), id: value.slice(slash + 1).trim() };
}

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0 ? (value as string[]) : undefined;

export function parseOptions(raw: Record<string, unknown> | undefined): Options {
  const options = raw ?? {};
  const model = parseModel(options.model);
  const messages = Number(options.messages ?? 10);
  const policy = (options.policy ?? {}) as Record<string, unknown>;
  return {
    model,
    problem: model
      ? undefined
      : 'auto-mode: set "model" to "provider/model" in the plugin options; until then every check is left to you',
    enabled: options.enabled !== false,
    yoloEdits: options.yoloEdits !== false,
    messages: Number.isFinite(messages) && messages >= 0 ? Math.floor(messages) : 10,
    includeAgentsMd: toggle(options.includeAgentsMd),
    includeMemory: toggle(options.includeMemory),
    memoryDir: typeof options.memoryDir === "string" && options.memoryDir.trim() ? options.memoryDir.trim() : "~/.aim",
    memoryFile:
      typeof options.memoryFile === "string" && options.memoryFile.trim() ? options.memoryFile.trim() : "memory-current.jsonl",
    review: options.review === "prompts" ? "prompts" : "all",
    log: options.log !== false,
    keybind: typeof options.keybind === "string" && options.keybind.trim() ? options.keybind.trim() : "<leader>d",
    alikeTools: Array.isArray(options.alikeTools)
      ? options.alikeTools.filter((tool): tool is string => typeof tool === "string" && tool.trim() !== "").map((tool) => tool.trim())
      : [...DEFAULT_ALIKE_TOOLS],
    policy: { trusted: strings(policy.trusted), blocks: strings(policy.blocks), exceptions: strings(policy.exceptions) },
  };
}
