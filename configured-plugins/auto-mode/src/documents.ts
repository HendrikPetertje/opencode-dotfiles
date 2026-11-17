import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, expandHome } from "./paths.ts";
import type { ProjectSettings } from "./settings.ts";

export interface Document {
  title: string;
  path: string;
  text: string;
}

function readText(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Nearest file at `relative` from `start` upwards, skipping `exclude`. */
function nearest(start: string | undefined, relative: string, exclude?: string): string | undefined {
  for (let dir = start; dir; ) {
    const candidate = join(dir, relative);
    if (candidate !== exclude && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Renders an mcp-knowledge-graph JSONL store as plain lines. */
export function renderMemory(jsonl: string): string | undefined {
  const lines: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "entity") {
        const observations = Array.isArray(row.observations) ? row.observations : [];
        lines.push(`- ${row.name} [${row.entityType}]${observations.length ? `: ${observations.join("; ")}` : ""}`);
      } else if (row.type === "relation") {
        lines.push(`- ${row.from} --${row.relationType}--> ${row.to}`);
      }
    } catch {}
  }
  return lines.length ? lines.join("\n") : undefined;
}

export interface DocumentOptions {
  directory: string | undefined;
  settings: ProjectSettings;
  memoryDir: string;
  memoryFile: string;
}

/** AGENTS.md files first, then memories, then AUTO_MODE_INSTRUCTIONS.md (always included when present). */
export function collectDocuments(options: DocumentOptions): { background: Document[]; instructions: Document[] } {
  const background: Document[] = [];
  const instructions: Document[] = [];
  const global = configDir();
  const push = (list: Document[], title: string, path: string | undefined, render?: (text: string) => string | undefined) => {
    if (!path) return;
    const raw = readText(path);
    const text = raw && render ? render(raw) : raw;
    if (text) list.push({ title, path, text });
  };

  const globalAgents = join(global, "AGENTS.md");
  if (options.settings.globalAgentsMd) push(background, "Global AGENTS.md", globalAgents);
  if (options.settings.projectAgentsMd) push(background, "Project AGENTS.md", nearest(options.directory, "AGENTS.md", globalAgents));

  const globalMemoryDir = expandHome(options.memoryDir);
  if (options.settings.globalMemory) {
    push(background, "Global memory", join(globalMemoryDir, options.memoryFile), renderMemory);
  }
  if (options.settings.projectMemory) {
    const projectAim = nearest(options.directory, ".aim", globalMemoryDir);
    push(background, "Project memory", projectAim && join(projectAim, options.memoryFile), renderMemory);
  }

  push(instructions, "Global AUTO_MODE_INSTRUCTIONS.md", join(global, "AUTO_MODE_INSTRUCTIONS.md"));
  const projectInstructions = nearest(options.directory, join(".opencode", "AUTO_MODE_INSTRUCTIONS.md"));
  if (projectInstructions !== join(global, "AUTO_MODE_INSTRUCTIONS.md")) {
    push(instructions, "Project AUTO_MODE_INSTRUCTIONS.md", projectInstructions);
  }
  return { background, instructions };
}
