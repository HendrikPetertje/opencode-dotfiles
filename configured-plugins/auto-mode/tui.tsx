/**
 * Auto mode TUI: a sidebar list of the latest decisions, a footer icon when
 * the sidebar is hidden, and a modal to browse decisions, change what happens
 * to a command for the rest of the session, and edit settings.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { stateDir } from "./src/paths.ts";
import { cachedShare, emptyCost, formatUsd, type CostTotal } from "./src/cost.ts";
import { cycle, type Override } from "./src/overrides.ts";
import { shorten, type CallRecord } from "./src/records.ts";
import { AutoMode } from "./src/rpc.ts";
import type { ProjectSettings, SettingRow } from "./src/settings.ts";

interface Payload {
  enabled: boolean;
  yoloEdits: boolean;
  settings: ProjectSettings;
  rows: SettingRow[];
  problem: string | null;
  model: string | null;
  keybind: string;
  rootID: string;
  records: (CallRecord & { override: Override })[];
  cost: CostTotal;
  /** Guarded reviews left after a deny; 0 when not on guard. */
  guard: number;
}

function costDetail(cost: CostTotal | undefined): string {
  const total = cost ?? emptyCost();
  const share = cachedShare(total);
  const parts = [formatUsd(total), `${total.reviews} review${total.reviews === 1 ? "" : "s"}`];
  if (share !== undefined) parts.push(`${Math.round(share * 100)}% cached`);
  if (total.unpriced > 0) parts.push(`${total.unpriced} unpriced`);
  return parts.join(" · ");
}

const ICON = {
  shield: "\uF132",
  power: "\uF011",
  pencil: "\uF040",
  gear: "\uF013",
  globe: "\uF0AC",
  folder: "\uF07B",
  messages: "\uF086",
  review: "\uF06E",
  model: "\uF2DB",
  guard: "\uF071",
  logs: "\uF07C",
};
const SPINNER = ["◜", "◠", "◝", "◞", "◡", "◟"];
const SIDEBAR_ROWS = 5;

/** The log folder as shown in settings, with the home folder as `~`. */
function logFolderLabel(): string {
  const dir = stateDir();
  const home = homedir();
  return dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
}

/** Opens the log folder in the OS file manager (Finder on macOS). */
function openLogFolder(): void {
  const dir = stateDir();
  try {
    mkdirSync(dir, { recursive: true });
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [dir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {}
}

// Terminal palette slots, so Ghostty's Rosé Pine (or any theme) supplies the
// colours: 1 love, 2 pine, 3 gold, 4 foam, 5 iris, 8 muted. The hex values
// are only used when the terminal palette is unknown.
function ansi(index: number, fallback: string) {
  const from = (RGBA as any)?.fromIndex;
  if (typeof from === "function") {
    try {
      return from.call(RGBA, index, fallback);
    } catch {}
  }
  return fallback;
}
const COLOR = {
  love: ansi(1, "#eb6f92"),
  pine: ansi(2, "#31748f"),
  gold: ansi(3, "#f6c177"),
  foam: ansi(4, "#9ccfd8"),
  iris: ansi(5, "#c4a7e7"),
  muted: ansi(8, "#6e6a86"),
  surface: ansi(0, "#26233a"),
};

const OVERRIDE_STYLE: Record<Override, { label: string; color: unknown }> = {
  deny: { label: "deny", color: COLOR.love },
  check: { label: "check", color: COLOR.gold },
  allow: { label: "allow", color: COLOR.foam },
  alike: { label: "allow alike", color: COLOR.pine },
};

function statusGlyph(record: CallRecord, frame: number): { glyph: string; color: unknown } {
  switch (record.status) {
    case "reviewing":
      return { glyph: SPINNER[frame % SPINNER.length]!, color: COLOR.gold };
    case "running":
      return { glyph: "·", color: COLOR.muted };
    case "allow":
      return { glyph: "✓", color: COLOR.foam };
    case "deny":
      return { glyph: "✗", color: COLOR.love };
    case "ask":
      return { glyph: "?", color: COLOR.gold };
    default:
      return { glyph: "·", color: COLOR.muted };
  }
}

// Yolo-allowed edits are noise; edits that yolo did not decide (dotfiles, outside the project) stay visible.
const visible = (payload: Payload | undefined) =>
  (payload?.records ?? []).filter((record) => !(payload!.yoloEdits && record.edit && record.source === "yolo")).slice().reverse();

export default Plugin.define({
  id: "auto-mode.tui",
  async setup(context) {
    const [store, update] = context.storage.memory("auto-mode", {
      initial: { states: {} as Record<string, Payload>, sidebars: 0, frame: 0, keybind: "<leader>d" },
    });
    const rpc = () => context.client.rpc(AutoMode) as any;
    const currentSession = () => {
      const route = context.ui.router.current();
      return route?.type === "session" ? route.sessionID : undefined;
    };
    const key = (sessionID: string | undefined) => sessionID ?? "home";
    const directory = () => context.location?.directory ?? context.data.location.default()?.directory;

    const store_ = (sessionID: string | undefined, payload: any) => {
      if (!payload || typeof payload !== "object") return;
      update((draft) => {
        draft.states[key(sessionID)] = payload as Payload;
        if (typeof payload.keybind === "string") draft.keybind = payload.keybind;
      });
    };
    const refresh = async (sessionID: string | undefined) => {
      try {
        store_(sessionID, await rpc().state({ sessionID, directory: directory() }));
      } catch {}
    };
    const call = async (method: string, sessionID: string | undefined, input: Record<string, unknown>) => {
      try {
        store_(sessionID, await rpc()[method]({ sessionID, directory: directory(), ...input }));
      } catch {}
    };

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = rpc().events.on("changed", () => {
        for (const id of Object.keys(store.states)) void refresh(id === "home" ? undefined : id);
      });
    } catch {}
    const spinner = setInterval(() => {
      const busy = Object.values(store.states).some((state) => state.records?.some((r) => r.status === "reviewing"));
      if (busy) update((draft) => void (draft.frame = (draft.frame + 1) % 600));
    }, 140);
    void refresh(currentSession());

    // ------------------------------------------------------------------ modal

    const open = (sessionID: string | undefined, recordID?: string, view: "decisions" | "settings" = "decisions") => {
      void refresh(sessionID);
      context.ui.dialog.show(() => <Modal sessionID={sessionID} recordID={recordID} view={view} />);
      context.ui.dialog.set({ size: "xlarge", centered: true });
    };

    /** OpenCode's own select dialog replaces the modal; the modal reopens on the settings view afterwards. */
    const pickModel = async (sessionID: string | undefined) => {
      let models = context.data.location.model.list() ?? [];
      if (models.length === 0) {
        await context.data.location.model.sync().catch(() => {});
        models = context.data.location.model.list() ?? [];
      }
      const current = store.states[key(sessionID)]?.settings.model;
      const value = await context.ui.dialog.select<string>({
        title: "Auto mode reviewer model",
        placeholder: "Search models",
        current,
        options: models
          .filter((model: any) => !model.type || model.type === "chat" || model.type === "language")
          .map((model: any) => ({
            title: model.name ?? model.modelID,
            value: `${model.providerID}/${model.modelID}`,
            description: `${model.providerID}/${model.modelID}`,
            category: model.providerID,
          })),
      });
      if (value) await call("setSetting", sessionID, { key: "model", value });
      open(sessionID, undefined, "settings");
    };

    /** Reviews are only priced and cacheable when the reviewer is on the chat model's provider. */
    const ModelMatch = (props: { model: string | null }) => {
      const chat = () => context.ui.model.current();
      const reviewer = () => props.model?.split("/")[0];
      const message = () => {
        const current = chat();
        if (!props.model) return { color: COLOR.love, text: "No reviewer model: press space on Reviewer model to pick one." };
        if (!current) return { color: COLOR.muted, text: "Keep the reviewer on the same provider as your chat model." };
        if (current.providerID === reviewer()) {
          return {
            color: COLOR.muted,
            text: `Reviewer and chat model (${current.providerID}/${current.modelID}) share a provider: reviews are priced and cached.`,
          };
        }
        return {
          color: COLOR.love,
          text: `Reviewer (${reviewer()}) and chat model (${current.providerID}) should match: on different providers reviews can't be priced or cached. Pick a ${current.providerID} reviewer.`,
        };
      };
      return <text fg={message().color as any}>{message().text}</text>;
    };

    const Modal = (props: { sessionID: string | undefined; recordID?: string; view?: "decisions" | "settings" }) => {
      const ctx = usePlugin();
      const state = () => store.states[key(props.sessionID)];
      const list = () => visible(state());
      const [view, setView] = createSignal<"decisions" | "settings">(props.view ?? "decisions");
      const initial = Math.max(0, list().findIndex((r) => r.id === props.recordID));
      const [selected, setSelected] = createSignal(initial);
      const [row, setRow] = createSignal(0);
      const selectedRecord = () => list()[Math.min(selected(), Math.max(0, list().length - 1))];
      let scroll: { scrollTo(position: number): void } | undefined;

      const move = (delta: number) => {
        if (view() === "settings") {
          setRow((r) => Math.max(0, Math.min((state()?.rows.length ?? 1) - 1, r + delta)));
          return;
        }
        const next = Math.max(0, Math.min(list().length - 1, selected() + delta));
        setSelected(next);
        scroll?.scrollTo(Math.max(0, next - 8));
      };
      const sideways = (step: -1 | 1) => {
        if (view() === "settings") {
          const setting = state()?.rows[row()];
          if (setting && setting.key !== "model" && setting.key !== "resetGuard" && setting.key !== "openLogs") {
            void call("setSetting", props.sessionID, { key: setting.key, input: step < 0 ? "left" : "right" });
          }
          return;
        }
        const record = selectedRecord();
        if (record) void call("setOverride", props.sessionID, { recordID: record.id, value: cycle(record.override, step) });
      };
      /** space, enter or a click on a settings row: toggle, open the model picker, or run the row's action. */
      const activate = (index: number) => {
        const setting = state()?.rows[index];
        if (!setting) return;
        setRow(index);
        if (setting.key === "model") void pickModel(props.sessionID);
        else if (setting.key === "resetGuard") void call("setSetting", props.sessionID, { key: "resetGuard" });
        else if (setting.key === "openLogs") openLogFolder();
        else void call("setSetting", props.sessionID, { key: setting.key, input: "toggle" });
      };
      const toggleEnabled = () => void call("setGlobal", props.sessionID, { enabled: !state()?.enabled });
      const toggleYolo = () => void call("setGlobal", props.sessionID, { yoloEdits: !state()?.yoloEdits });

      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          { bind: "j", run: () => move(1) },
          { bind: "k", run: () => move(-1) },
          { bind: "ctrl+d", run: () => move(10) },
          { bind: "ctrl+u", run: () => move(-10) },
          { bind: "g", run: () => move(-100000) },
          { bind: "shift+g", run: () => move(100000) },
          { bind: "h", run: () => sideways(-1) },
          { bind: "l", run: () => sideways(1) },
          { bind: "space", run: () => (view() === "settings" ? activate(row()) : false) },
          { bind: "return", run: () => (view() === "settings" ? activate(row()) : false) },
          { bind: "c", run: () => setView((v) => (v === "settings" ? "decisions" : "settings")) },
          { bind: "y", run: toggleYolo },
          { bind: "-", run: toggleEnabled },
        ],
      }));

      const on = () => state()?.enabled ?? false;
      const dim = (color: unknown) => (on() ? color : COLOR.muted);

      const Decisions = () => (
        <box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0} gap={2}>
          <scrollbox ref={(el: any) => (scroll = el)} width="40%" flexShrink={0} minHeight={0}>
            {list().map((record, index) => {
              const mark = () => statusGlyph(record, store.frame);
              const active = () => index === selected();
              return (
                <box
                  flexDirection="row"
                  flexShrink={0}
                  backgroundColor={active() ? (COLOR.surface as any) : undefined}
                  onMouseUp={() => setSelected(index)}
                >
                  <text fg={dim(mark().color) as any}>{`${mark().glyph} `}</text>
                  <text fg={dim(record.override === "check" ? ctx.theme.text.base : OVERRIDE_STYLE[record.override].color) as any}>
                    {shorten(record, 44)}
                  </text>
                </box>
              );
            })}
            {list().length === 0 && <text fg={COLOR.muted as any}>No tool calls in this session yet.</text>}
          </scrollbox>
          <box flexDirection="column" flexGrow={1} minHeight={0}>
            {selectedRecord() ? (
              <>
                <text fg={dim(statusGlyph(selectedRecord()!, store.frame).color) as any} attributes={TextAttributes.BOLD}>
                  {selectedRecord()!.status === "reviewing" ? "Reviewing…" : selectedRecord()!.reason || selectedRecord()!.status}
                </text>
                <text fg={COLOR.muted as any}>
                  {`${selectedRecord()!.action} · ${selectedRecord()!.status} · ${selectedRecord()!.source} · ${new Date(selectedRecord()!.at).toLocaleTimeString()}`}
                </text>
                <box height={1} flexShrink={0} />
                <scrollbox flexGrow={1} flexBasis={0} minHeight={0}>
                  <text fg={ctx.theme.text.base as any}>{selectedRecord()!.subject}</text>
                </scrollbox>
                <box flexDirection="row" flexShrink={0} gap={1}>
                  <text fg={COLOR.muted as any}>From now on:</text>
                  {(["deny", "check", "allow", "alike"] as Override[]).map((value) => (
                    <text
                      fg={(selectedRecord()!.override === value ? OVERRIDE_STYLE[value].color : COLOR.muted) as any}
                      attributes={selectedRecord()!.override === value ? TextAttributes.BOLD : 0}
                      onMouseUp={() => void call("setOverride", props.sessionID, { recordID: selectedRecord()!.id, value })}
                    >
                      {selectedRecord()!.override === value ? `[${OVERRIDE_STYLE[value].label}]` : ` ${OVERRIDE_STYLE[value].label} `}
                    </text>
                  ))}
                </box>
              </>
            ) : (
              <text fg={COLOR.muted as any}>Nothing selected.</text>
            )}
          </box>
        </box>
      );

      const Settings = () => (
        <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
          {(state()?.rows ?? []).map((setting, index) => {
            const guard = () => state()?.guard ?? 0;
            const value = () =>
              setting.key === "resetGuard" || setting.key === "openLogs" ? undefined : state()!.settings[setting.key];
            const text = () => {
              if (setting.key === "resetGuard") return guard() > 0 ? `on guard · ${guard()} reviews left` : "off";
              if (setting.key === "openLogs") return logFolderLabel();
              return typeof value() === "boolean" ? (value() ? "on" : "off") : String(value() || "not set");
            };
            const color = () => {
              if (setting.key === "resetGuard") return guard() > 0 ? COLOR.gold : COLOR.muted;
              if (setting.key === "openLogs") return COLOR.iris;
              return typeof value() === "boolean" ? (value() ? COLOR.foam : COLOR.muted) : COLOR.gold;
            };
            return (
              <box
                flexDirection="row"
                flexShrink={0}
                gap={1}
                backgroundColor={index === row() ? (COLOR.surface as any) : undefined}
                onMouseUp={() => activate(index)}
              >
                <text fg={COLOR.iris as any}>{ICON[setting.icon]}</text>
                <text fg={ctx.theme.text.base as any} width={22}>{setting.label}</text>
                <text fg={color() as any} attributes={TextAttributes.BOLD}>{text()}</text>
              </box>
            );
          })}
          <box height={1} flexShrink={0} />
          <text fg={COLOR.muted as any}>{state()?.rows[row()]?.description ?? ""}</text>
          <box height={1} flexShrink={0} />
          <ModelMatch model={state()?.model ?? null} />
          {state()?.problem && <text fg={COLOR.love as any}>{state()!.problem}</text>}
          <text fg={COLOR.muted as any}>Settings are remembered for this project.</text>
        </box>
      );

      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} height={28}>
          <box flexDirection="row" flexShrink={0} justifyContent="space-between">
            <box flexDirection="row" gap={1}>
              <text fg={dim(COLOR.foam) as any} attributes={TextAttributes.BOLD}>
                {`${ICON.shield} Auto mode${view() === "settings" ? " · settings" : ""}`}
              </text>
              <text fg={COLOR.muted as any}>{on() ? state()?.model ?? "no reviewer model" : "off: OpenCode's own rules apply"}</text>
              {on() && (state()?.guard ?? 0) > 0 && (
                <text fg={COLOR.gold as any}>{`${ICON.guard} on guard · ${state()!.guard} reviews left`}</text>
              )}
            </box>
            <text fg={COLOR.muted as any}>{costDetail(state()?.cost)}</text>
          </box>
          <box height={1} flexShrink={0} border={["top"]} borderColor={COLOR.muted as any} />
          {view() === "settings" ? <Settings /> : <Decisions />}
          <box flexDirection="row" flexShrink={0} justifyContent="space-between">
            <text fg={COLOR.muted as any}>
              {view() === "settings"
                ? "esc close · j/k/g/G scroll · space/enter/click select · h/l change"
                : "esc close · j/k/g/G scroll · h/l toggle mode"}
            </text>
            <box flexDirection="row" gap={2}>
              <text fg={(view() === "settings" ? COLOR.iris : COLOR.muted) as any} onMouseUp={() => setView((v) => (v === "settings" ? "decisions" : "settings"))}>
                {`${ICON.gear} config (c)`}
              </text>
              <text fg={(state()?.yoloEdits ? COLOR.gold : COLOR.muted) as any} onMouseUp={toggleYolo}>
                {`${ICON.pencil} file yolo (y)`}
              </text>
              <text fg={(on() ? COLOR.foam : COLOR.muted) as any} onMouseUp={toggleEnabled}>
                {`${ICON.power} ${on() ? "ON" : "OFF"} (-)`}
              </text>
            </box>
          </box>
        </box>
      );
    };

    // ------------------------------------------------------------------ sidebar

    const Sidebar = (props: { sessionID: string }) => {
      const ctx = usePlugin();
      onMount(() => {
        update((draft) => void (draft.sidebars += 1));
        void refresh(props.sessionID);
      });
      onCleanup(() => update((draft) => void (draft.sidebars = Math.max(0, draft.sidebars - 1))));
      const state = () => store.states[key(props.sessionID)];
      const on = () => state()?.enabled ?? false;
      const rows = () => visible(state()).slice(0, SIDEBAR_ROWS);
      return (
        <box flexDirection="column" flexShrink={0}>
          <box flexDirection="row" gap={1} onMouseUp={() => open(props.sessionID)}>
            <text fg={(!on() ? COLOR.muted : (state()?.guard ?? 0) > 0 ? COLOR.gold : COLOR.foam) as any}>{ICON.shield}</text>
            <text fg={(on() ? ctx.theme.text.base : COLOR.muted) as any} attributes={TextAttributes.BOLD}>
              Auto mode
            </text>
            {state()?.yoloEdits && <text fg={(on() ? COLOR.gold : COLOR.muted) as any}>{ICON.pencil}</text>}
            <text fg={COLOR.muted as any} marginLeft={1}>{formatUsd(state()?.cost ?? emptyCost())}</text>
          </box>
          {rows().map((record) => {
            const mark = () => statusGlyph(record, store.frame);
            return (
              <box flexDirection="row" onMouseUp={() => open(props.sessionID, record.id)}>
                <text fg={(on() ? mark().color : COLOR.muted) as any}>{`${mark().glyph} `}</text>
                <text fg={(on() ? ctx.theme.text.base : COLOR.muted) as any}>{shorten(record, 30)}</text>
              </box>
            );
          })}
          <text fg={COLOR.muted as any} onMouseUp={() => open(props.sessionID)}>
            {rows().length === 0 ? "no tool calls yet" : "… more"}
          </text>
        </box>
      );
    };

    // ------------------------------------------------------------------ footer

    const FooterIcon = (props: { sessionID?: string }) => {
      onMount(() => void refresh(props.sessionID));
      const state = () => store.states[key(props.sessionID)];
      const reviewing = () => state()?.records?.some((r) => r.status === "reviewing") ?? false;
      return store.sidebars > 0 ? null : (
        <box flexDirection="row" flexShrink={0} onMouseUp={() => open(props.sessionID)}>
          <text fg={(!state()?.enabled ? COLOR.muted : reviewing() || (state()?.guard ?? 0) > 0 ? COLOR.gold : COLOR.foam) as any}>
            {reviewing() && state()?.enabled ? SPINNER[store.frame % SPINNER.length] : ICON.shield}
          </text>
        </box>
      );
    };

    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <Sidebar sessionID={input.sessionID} />,
    });
    const stopFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const route = context.ui.router.current();
        return route?.type === "session" ? <FooterIcon sessionID={route.sessionID} /> : null;
      },
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "auto-mode.open",
          title: "Show auto mode decisions",
          group: "Auto mode",
          bind: store.keybind,
          palette: true,
          slash: { name: "auto-mode" },
          run: () => open(currentSession()),
        },
      ],
      bindings: ["auto-mode.open"],
    }));

    return () => {
      clearInterval(spinner);
      unsubscribe?.();
      stopSidebar?.();
      stopFooter?.();
    };
  },
});
