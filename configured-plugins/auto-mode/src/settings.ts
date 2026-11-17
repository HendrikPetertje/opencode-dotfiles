import type { Options } from "./options.ts";

/** Remembered across projects and sessions; shown as footer buttons in the modal. */
export interface GlobalSettings {
  enabled: boolean;
  yoloEdits: boolean;
}

/** Remembered per project; edited in the modal's settings view. */
export interface ProjectSettings {
  globalAgentsMd: boolean;
  projectAgentsMd: boolean;
  globalMemory: boolean;
  projectMemory: boolean;
  messages: number;
  review: "all" | "prompts";
  /** Reviewer as "provider/model"; starts as the `model` option, changed with the picker. */
  model: string;
}

export function globalDefaults(options: Options): GlobalSettings {
  return { enabled: options.enabled, yoloEdits: options.yoloEdits };
}

export function projectDefaults(options: Options): ProjectSettings {
  return {
    globalAgentsMd: options.includeAgentsMd.global,
    projectAgentsMd: options.includeAgentsMd.project,
    globalMemory: options.includeMemory.global,
    projectMemory: options.includeMemory.project,
    messages: options.messages,
    model: options.model ? `${options.model.providerID}/${options.model.id}` : "",
    review: options.review,
  };
}

export type SettingKey = keyof ProjectSettings;
/** Rows that run an action instead of changing a stored setting. */
export type ActionKey = "resetGuard" | "openLogs";

export interface SettingRow {
  key: SettingKey | ActionKey;
  label: string;
  icon: "globe" | "folder" | "messages" | "review" | "model" | "guard" | "logs";
  description: string;
}

export const SETTING_ROWS: readonly SettingRow[] = [
  {
    key: "model",
    label: "Reviewer model",
    icon: "model",
    description: "space: pick the model that reviews tool calls.",
  },
  { key: "globalAgentsMd", label: "Global AGENTS.md", icon: "globe", description: "Send the global AGENTS.md to the reviewer." },
  { key: "projectAgentsMd", label: "Project AGENTS.md", icon: "folder", description: "Send the project's AGENTS.md to the reviewer." },
  { key: "globalMemory", label: "Global memory", icon: "globe", description: "Send the global memory graph to the reviewer." },
  { key: "projectMemory", label: "Project memory", icon: "folder", description: "Send the project memory graph to the reviewer." },
  {
    key: "messages",
    label: "Recent messages",
    icon: "messages",
    description: "How many of your latest messages (plus the tool calls since) the reviewer sees. h/l to change.",
  },
  {
    key: "review",
    label: "Review",
    icon: "review",
    description: "all: review everything OpenCode would allow too. prompts: only review what would ask you.",
  },
  {
    key: "resetGuard",
    label: "Reset vigilance mode",
    icon: "guard",
    description:
      "After a deny, the next 10 reviewed calls in this session get a full review with the denials in view (each new deny restarts the count). space: end it now.",
  },
  {
    key: "openLogs",
    label: "Open log folder",
    icon: "logs",
    description: "decisions.jsonl (every decision) and plugin.log (errors), latest 1000 lines each. space: open the folder.",
  },
];

/** Applies a space/h/l press to one setting. */
export function adjust(settings: ProjectSettings, key: SettingKey, input: "toggle" | "left" | "right"): ProjectSettings {
  const next = { ...settings };
  if (key === "model") return next;
  if (key === "messages") {
    const step = input === "left" ? -1 : 1;
    next.messages = input === "toggle" ? settings.messages : Math.max(0, Math.min(50, settings.messages + step));
    return next;
  }
  if (key === "review") {
    next.review = input === "toggle" ? (settings.review === "all" ? "prompts" : "all") : input === "left" ? "prompts" : "all";
    return next;
  }
  next[key] = input === "toggle" ? !settings[key] : input === "right";
  return next;
}
