/**
 * Footer counter for the `memory` MCP knowledge graph (mcp-knowledge-graph).
 * Shows entities/observations/relations for the global and project stores,
 * as coloured text, refreshes when the files change, and opens a scrollable
 * dialog listing the memories when a segment is clicked.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE = "memory-current.jsonl";
const GLOBAL_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".aim");

type Counts = { e: number; o: number; r: number } | undefined;

function count(file: string): Counts {
  if (!existsSync(file)) return undefined;
  const counts = { e: 0, o: 0, r: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "entity") {
        counts.e++;
        counts.o += Array.isArray(row.observations) ? row.observations.length : 0;
      } else if (row.type === "relation") counts.r++;
    } catch {}
  }
  return counts;
}

function projectDir(start: string | undefined): string | undefined {
  let dir = start;
  while (dir) {
    const candidate = join(dir, ".aim");
    if (candidate !== GLOBAL_DIR && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const ICON = { globe: "\uF0AC", folder: "\uF07B", empty: "\u{F0159}" };

// Accent colours mirror the ANSI palette of the Ghostty themes
// ("Peva Rose Pine" / "Peva Rose Pine Dawn": palette 4 foam, 3 gold, 5 iris,
// 6 rose), picked by the TUI's light/dark mode. Text colours follow the theme.
const ANSI = {
  dark: { global: "#9ccfd8", project: "#f6c177", entity: "#c4a7e7", relation: "#ebbcba" },
  light: { global: "#56949f", project: "#ea9d34", entity: "#907aa9", relation: "#d7827e" },
};
const palette = (ctx: { theme: any; themeMode: "dark" | "light" }) => ({
  ...ANSI[ctx.themeMode === "light" ? "light" : "dark"],
  muted: ctx.theme.text.muted,
  text: ctx.theme.text.base,
});

const fmt = (c: Counts) => (c ? `${c.e}E ${c.o}O ${c.r}R` : ICON.empty);

type Entity = { name: string; type: string; observations: string[] };
type Relation = { from: string; to: string; type: string };
type Graph = { entities: Entity[]; relations: Relation[] } | undefined;

function load(file: string | undefined): Graph {
  if (!file || !existsSync(file)) return undefined;
  const graph = { entities: [] as Entity[], relations: [] as Relation[] };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "entity") {
        graph.entities.push({ name: row.name, type: row.entityType, observations: row.observations ?? [] });
      } else if (row.type === "relation") {
        graph.relations.push({ from: row.from, to: row.to, type: row.relationType });
      }
    } catch {}
  }
  return graph;
}

export default Plugin.define({
  id: "memory-ticker.tui",
  setup(context) {
    const [state, update] = context.storage.memory("memory-ticker", {
      initial: { g: "…", p: "…" },
    });

    const currentProject = () => {
      const dir = projectDir(context.location?.directory ?? context.data.location.default()?.directory);
      return dir ? join(dir, FILE) : undefined;
    };

    const refresh = () => {
      const dir = projectDir(context.location?.directory ?? context.data.location.default()?.directory);
      const g = fmt(count(join(GLOBAL_DIR, FILE)));
      const p = fmt(dir ? count(join(dir, FILE)) : undefined);
      if (g !== state.g || p !== state.p) {
        update((draft) => {
          draft.g = g;
          draft.p = p;
        });
      }
    };

    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const dirs = [GLOBAL_DIR, projectDir(context.location?.directory)].filter((d): d is string => !!d);
    for (const dir of dirs) {
      try {
        watchers.push(watch(dir, schedule));
      } catch {}
    }
    // Catches stores created after startup (no directory to watch yet).
    const poll = setInterval(refresh, 5000);
    refresh();

    const open = (title: string, icon: string, kind: "global" | "project", file: string | undefined) => {
      const graph = load(file);
      const obsCount = graph?.entities.reduce((n, e) => n + e.observations.length, 0) ?? 0;
      context.ui.dialog.show(() => {
        const ctx = usePlugin();
        const pal = () => palette(ctx);
        return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} height={26}>
          <box flexDirection="row" flexShrink={0} gap={1}>
            <text fg={pal()[kind]} attributes={TextAttributes.BOLD}>{`${icon} ${title} memory`}</text>
            <text fg={pal().muted}>
              {graph
                ? `${graph.entities.length} entities · ${obsCount} observations · ${graph.relations.length} relations`
                : "no memory file"}
            </text>
          </box>
          <box height={1} flexShrink={0} border={["top"]} borderColor={pal().muted} />
          <scrollbox focused flexGrow={1} flexBasis={0} minHeight={0}>
            {graph?.entities.map((e) => (
              <box flexDirection="column" flexShrink={0} marginBottom={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={pal().entity} attributes={TextAttributes.BOLD}>{`◆ ${e.name}`}</text>
                  <text fg={pal().muted}>{`[${e.type}]`}</text>
                </box>
                {e.observations.map((o) => (
                  <box flexDirection="row" paddingLeft={2} flexShrink={0}>
                    <text fg={pal()[kind]} flexShrink={0}>{"› "}</text>
                    <text fg={pal().text}>{o}</text>
                  </box>
                ))}
              </box>
            ))}
            {graph && graph.relations.length > 0 && (
              <box flexDirection="column" flexShrink={0}>
                <text fg={pal().relation} attributes={TextAttributes.BOLD}>{"⇄ Relations"}</text>
                {graph.relations.map((r) => (
                  <box flexDirection="row" paddingLeft={2} flexShrink={0}>
                    <text fg={pal().entity}>{r.from}</text>
                    <text fg={pal().muted}>{" ──"}</text>
                    <text fg={pal().relation}>{` ${r.type} `}</text>
                    <text fg={pal().muted}>{"──▶ "}</text>
                    <text fg={pal().entity}>{r.to}</text>
                  </box>
                ))}
              </box>
            )}
            {!graph && <text fg={pal().muted}>No memory file found.</text>}
            {graph && graph.entities.length === 0 && <text fg={pal().muted}>Empty.</text>}
          </scrollbox>
          <text fg={pal().muted} flexShrink={0}>{"esc close · wheel/↑↓/PgUp/PgDn scroll · Home/End jump"}</text>
        </box>
        );
      });
      context.ui.dialog.set({ size: "xlarge", centered: true });
    };

    const Ticker = () => {
      const ctx = usePlugin();
      const pal = () => palette(ctx);
      return (
      <box flexDirection="row" flexShrink={0} gap={2}>
        <box onMouseUp={() => open("Global", ICON.globe, "global", join(GLOBAL_DIR, FILE))}>
          <text fg={pal().global}>{`${ICON.globe} ${state.g}`}</text>
        </box>
        <box onMouseUp={() => open("Project", ICON.folder, "project", currentProject())}>
          <text fg={pal().project}>{`${ICON.folder} ${state.p}`}</text>
        </box>
        <text fg={pal().muted}>{"│"}</text>
      </box>
      );
    };
    const stopHome = context.ui.slot({ append: "home.footer.status", render: () => <Ticker /> });
    const stopPrompt = context.ui.slot({ append: "prompt.footer.status", render: () => <Ticker /> });

    return () => {
      clearInterval(poll);
      clearTimeout(timer);
      watchers.forEach((w) => w.close());
      stopHome?.();
      stopPrompt?.();
    };
  },
});
