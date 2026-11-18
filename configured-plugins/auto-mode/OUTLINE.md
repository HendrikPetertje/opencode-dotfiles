# OUTLINE (for AI agents)

Read this before changing the plugin. It explains how the files fit together,
the patterns they follow, and the traps. User-facing docs are in `README.md`.

## What it is

An OpenCode **V2** plugin (`@opencode/plugin` 2.3.x) with two halves loaded from
one package (`package.json` `exports`: `.` -> `index.ts`, `./tui` -> `tui.tsx`):

- **Server half** (`index.ts`): hooks `permission.evaluate` and decides
  allow / deny / ask for each permission check, using fast rules first and a
  reviewer model (`ctx.experimental.generate.text`) for the rest.
- **TUI half** (`tui.tsx`): sidebar list, footer icon, modal. It has **no
  access to server options or state** and talks to the server only through
  the RPC in `src/rpc.ts`.

Registered in `~/.config/opencode/opencode.jsonc` as
`{ "package": "./configured-plugins/auto-mode", "options": { "model": "provider/model", ... } }`.
It lives in `configured-plugins/`, not `plugins/`: OpenCode auto-loads every
directory under `plugins/` **without options**, which would load a second,
model-less copy next to the configured one.

## File map

| File | Role | Imports from |
|---|---|---|
| `index.ts` | Server plugin. Storage, session lookups, records, RPC handlers, the evaluate pipeline, reviewer calls, event subscription for "always" replies. | everything in `src/` |
| `tui.tsx` | TUI plugin. Solid/OpenTUI components `Modal`, `Sidebar`, `FooterIcon`; keymap; colours. | `src/rpc.ts`, `src/records.ts`, `src/overrides.ts`, `src/settings.ts` (types + pure helpers only) |
| `src/rpc.ts` | `Rpc.define` with methods `state`, `setGlobal`, `setSetting`, `setOverride` and event `changed`. Loose `{type:"object"}` schemas. | `@opencode/plugin/rpc` |
| `src/options.ts` | Parses plugin options into `Options`. `parseModel` splits `"provider/model"` on the **first** `/`. Missing model -> `problem` string (plugin still runs, review-tier calls escalate to the user). | - |
| `src/settings.ts` | `GlobalSettings` (enabled, yoloEdits; global) and `ProjectSettings` (reviewer `model`, AGENTS.md/memory toggles, messages, review scope; per project). `model` is set via `setSetting({ key: "model", value })` from the TUI picker (`ui.dialog.select`), never via `adjust`; `reviewerFor(settings)` falls back to the `model` option. Defaults come from options. `SETTING_ROWS` drives the modal's settings view; `adjust` applies space/h/l. Rows can also be actions (`ActionKey`): `resetGuard` is handled in `setSetting` before any stored setting and ends the session's vigilance. | `options.ts` (type) |
| `src/tiers.ts` | Instant classification: `allow` (read-only tools/commands, subagent starts, yolo in-project edits, reads outside the project), `deny` (catastrophic regexes), `review` (everything else). `sensitivePath`: any dot segment (`.env`, `.aws/`, `.config/`) or secret file name; a shell segment, `read` resource or yolo edit that mentions one is never instant (also inside `--flag=` and `VAR=` values). `grep`/`glob` tools stay instant: their resource is the pattern, not the searched path. `EDIT_ACTIONS`. | `shell.ts` |
| `src/shell.ts` | Quote-aware split of a shell command into segments; flags substitution/eval (`dynamic`) and file redirects (`writes`). Not a real parser: it only has to be conservative. | - |
| `src/config-rules.ts` | Reads `permissions` from all OpenCode config files in precedence order (global, ancestors' `opencode.json(c)`, ancestors' `.opencode/`), plus `agents.<agent>.permissions`. `userDecides` = the user wrote a rule for this specific tool/command -> leave OpenCode's decision alone. | `jsonc.ts`, `paths.ts`, `wildcard.ts` |
| `src/overrides.ts` | Per-session user choices: `deny` / `check` / `allow` (modal row modes; "always" on a prompt = `allow`). `exactKey(action, subject)` identifies a call. `addAllow` / `removeAllow`: `allow` puts the tool in `always`, or for tools matching the `alikeTools` option (`isAlikeTool`, wildcards; `DEFAULT_ALIKE_TOOLS` = `shell`, `execute`, `webfetch`, `read`, `grep`, `glob`) an `AlikeEntry` the reviewer checks. The list reaches the TUI in the `state` payload. | `wildcard.ts` |
| `src/transcript.ts` | Builds the reviewer's view of the session: last N user messages and every tool call since, **without** assistant text or tool output. `findToolCommand` recovers the full shell command by tool-call ID; `findToolCall` recovers the input behind a catch-all `*` permission (MCP tools), so the subject is the real input, or `inside execute: <code>` for Code Mode calls. | - |
| `src/documents.ts` | Collects global/project `AGENTS.md`, global/project memory (`.aim/<memoryFile>` JSONL rendered as lines) and `AUTO_MODE_INSTRUCTIONS.md` (global config dir, then nearest `.opencode/`). Instructions are always included; the rest follows `ProjectSettings`. | `paths.ts`, `settings.ts` |
| `src/reviewer.ts` | Prompt building (`systemPrompt` = fixed, cacheable; `questionPrompt` = per call), default policy (trusted / blocks / exceptions, overridable via `options.policy`), answer parsing. | `documents.ts`, `options.ts` (types) |
| `src/records.ts` | `CallRecord` (one row in the UI), status/source enums, `shorten`. Shared by both halves. | `overrides.ts` (type) |
| `src/cost.ts` | Per-session reviewer cost totals, `$` formatting, cached share. | - |
| `src/guard.ts` | Vigilance after a deny: `Guard { remaining, recent }`. `onDeny` resets to `GUARD_REVIEWS` (10) and keeps the last 3 denials; `onReview` counts down and clears `recent` at 0. | - |
| `src/log.ts` | Appends to `~/.local/state/opencode-auto-mode/decisions.jsonl` and `plugin.log` through one queue per file; trims each back to the last 1000 lines (`keepLast`) once it reaches 1050. The settings row `openLogs` is a TUI-only action (spawns `open`/`xdg-open`; the server ignores it). | `paths.ts` |
| `src/paths.ts` | `configDir()` (respects `XDG_CONFIG_HOME`), `stateDir()` (respects `XDG_STATE_HOME`), `expandHome`. | - |
| `src/jsonc.ts`, `src/wildcard.ts` | JSONC -> JSON; OpenCode wildcard semantics (`*` any incl. `/`, `?` one char). | - |
| `src/auto-mode.test.ts` | `bun test` for every pure module. No OpenCode imports. | pure modules |

## The evaluate pipeline (`index.ts`, `permission.hook("evaluate")`)

OpenCode calls the hook after its own rules, for `allow` and `ask` results
(configured `deny` never reaches it). Saved "always" approvals are already
merged into `event.effect`. The hook mutates `event.effect` / `event.message`.
The order below matters:

1. Resolve session info (root session, project key, directory). For `shell`,
   fetch session messages to recover the full command (OpenCode passes one
   resource per sub-command).
2. Find or create the `CallRecord` (keyed by `event.source.id` = tool-call ID,
   created earlier by `tool.hook("execute.before")`). A second check for the
   same call (shell checks `external_directory` first) gets its own record.
3. **Off** -> record `off`, leave the effect alone.
4. **User config rule for this specific tool/command** (`userDecides`) -> leave the effect alone.
5. **Session override** exact match: deny / allow. `check` (no override) runs the rest.
6. **Always**: the tool is in the session's `always` list (`allow` on a non-`alikeTools` tool) -> allow.
7. **Tiers** (`classify`): catastrophic -> deny, read-only/yolo -> allow.
8. Review scope `prompts` and OpenCode would allow -> leave it.
9. **Cache**: the reviewer allowed this exact subject earlier in the session -> allow. Skipped while on guard.
10. **Refused stays refused**: same subject denied by the reviewer and no new user message since -> deny.
11. **Reviewer alike**: the session's `alikes` for this tool (`allow` on a `alikeTools` tool, with the user's message at that time as the goal). One-word `alikePrompt` question: `ALIKE` -> allow, anything else -> on to review. Skipped while on guard.
12. **Review**: triage question (one word). `ALLOW` -> allow. Otherwise the reasoning question -> allow / deny / ask. No answer -> ask.
    While on guard the triage is skipped, every review uses up one guarded call, and `ReviewRequest.recentDenials` puts the last denials before the pending action.

### Decision rules (prompt, `src/reviewer.ts`)

- DENY only when a block rule matches without exception or explicit authorization.
- ASK for real side effects outside the trusted boundary the user didn't request, or when the user asked to be asked. The reviewer stands in for a human approver: unsure means ask, not refuse.
- ALLOW ordinary work inside the trusted boundary, read-only actions, and what the user asked for.
- Triage answers BLOCK (go to full review) for anything outside the boundary, near a block rule, or when the user asked to be asked; otherwise a harmless call would never reach ASK.

### Vigilance (`src/guard.ts`)

Every call to `deny()` (reviewer, catastrophic, override, refused, and the
backstop's would-be deny) runs `onDeny`: the root session is on guard for the
next 10 reviewed calls, and each new deny resets the count. Stored with the
records; shown as a gold shield and "on guard · N reviews left"; ended early
by the `resetGuard` settings row.

### How a review call is made (`ask` in `index.ts`)

- The prompt is split in `src/reviewer.ts`: `systemPrompt` (role, policy,
  background docs, reviewer instructions; **nothing per call**, so providers
  can cache it) and `questionPrompt` (transcript first, pending action and
  answer format last). Keep that split when editing prompts.
- Preferred path: `ctx.session.generate({ sessionID, prompt })`, a transient
  call on the user's own session (no new session, not stored in history) that
  returns `tokens` and `cost`. The prompt ends with `[review <nonce>]`.
  - `experimental.model.resolve` hook (kind `generate`, session has a pending
    review): swaps in the reviewer model. It can only pick a model from the
    session's provider; otherwise it marks the call `mismatch`.
  - `generate` hook: when the last message carries a pending nonce, replaces
    `system` with the reviewer system prompt, keeps only that last message
    (no session history reaches the reviewer), clears `tools`, caps `maxTokens`.
  - The answer is used only if the `generate` hook marked the call `shaped`.
- Fallback: `generate.text` with system + question in one prompt. Used for
  sessions on another provider (`textOnly`), and for the rest of the process
  once the session path fails or the hook didn't run (`sessionPathBroken`).
  It reports no cost; those reviews count as `unpriced` and the total shows `+`.
- `src/cost.ts` keeps a `CostTotal` per root session, stored with the records
  (`records:<rootID>` = `{ list, cost, guard }`) and shown in the sidebar header and
  the modal's top-right.

`deny()` has a backstop: 3 denials in a row or 20 per session -> ask instead.
Errors anywhere -> ask (fail toward the user, never toward allow).

## State and where it lives

| State | Scope | Storage |
|---|---|---|
| `GlobalSettings` (on/off, yolo) | all projects | `ctx.storage` key `global` |
| `ProjectSettings` | project (`id:<projectID>`, else `dir:<path>`) | `ctx.storage` key `project:<key>` |
| Overrides (exact deny/allow per call), `always` tools and reviewer-checked `alikes` | root session (subagent sessions share their parent's) | `ctx.storage` key `session:<rootID>` |
| Records (the UI list, max 300 per root session), cost total, vigilance guard | root session | `ctx.storage` key `records:<rootID>` = `{ list, cost, guard }`, debounced 500 ms, flushed on unload. On load, `running`/`reviewing` rows become `off` ("interrupted by a plugin reload"). Call `ensureRecords(rootID)` before touching a session's records, cost or guard. |
| Reviewer cache, refusals, denial counts | process memory | gone on a server restart |
| Memory plugin present (`memoryAvailable`) | per plugin copy | `ctx.tool.list()` has a tool matching `/(^\|_)aim_memory_/`, cached 30 s; the `memory` option `true`/`false` skips the check |
| Decision log, error log | disk | `stateDir()`, outside every watched directory |

The server runs one copy of the plugin per location (the home directory and each
project), plus a new copy on every hot reload. Hooks run in the session's
project copy, but the TUI's RPC can land in another copy. So every in-memory map
and `GlobalSettings` live in one object on `globalThis.__opencodeAutoMode`, shared by
all copies in the process. Create any new mutable state there too, and mutate
`global` in place, never reassign it.

## Memory is optional

The `.aim` memory comes from a separate plugin (memory MCP). Auto mode must work
without it. Every memory read goes through `effectiveSettings(settings,
await memoryAvailable())` before `collectDocuments`, and the settings rows go
through `visibleRows`, so without the plugin the memory rows are hidden and
`setSetting` ignores them. Keep any new memory feature behind the same check.

## TUI <-> server

- The TUI calls `state({ sessionID, directory })` and gets everything it renders
  (settings, `rows`, model, keybind, the root session's records with their
  current `override` from `modeFor`, `allowed` = the session's `always` tools
  and `alikes`, and the `alikeTools` option).
- Mutations (`setGlobal`, `setSetting`, `setOverride`) return a fresh `state` payload.
- After any change the server emits `changed`; the TUI re-fetches every
  session state it holds, plus the session on screen. Records are not streamed one by one.
- The sidebar and footer icon take the session from the route (`currentSession()`),
  not the slot's `sessionID`: a new chat draws the sidebar before its session
  exists, and the slot does not pass the new ID.
- The TUI caches payloads in `context.storage.memory("auto-mode")` keyed by
  session ID (`"home"` without one), plus a spinner frame and a count of
  mounted sidebars. `FooterIcon` renders only when no sidebar is mounted.
- `AskReason` (slot `session.composer.top`): OpenCode's permission prompt does
  not show a request's `message`, so this reads pending requests for the
  session family (`context.data.session.permission.list`) and shows those whose
  message starts with `auto-mode` in a gold-bordered block on a `surface` background.
- The TUI logs RPC failures to `plugin.log` (`tui …`), except `rpc.unavailable`
  while the server is still starting.

## Patterns to keep

- **Pure modules + thin glue.** Logic lives in `src/*` without OpenCode
  imports so it can be unit tested; `index.ts` / `tui.tsx` only wire it up.
  Add tests to `src/auto-mode.test.ts` for any new rule.
- **Fail toward the user.** Unknown, unclear or failed -> `ask`. Never default to `allow`.
- **The reviewer never sees assistant text or tool output** (prompt-injection
  surface). Do not add them to the transcript.
- **Never write inside the config dir or a project** at runtime: OpenCode
  watches them and reloads plugins in a loop. Use `stateDir()`.
- **Respect user rules.** If the user wrote a rule for a specific tool or
  command, OpenCode's decision stands. Only the catch-all `*` space is auto mode's.
- **Colours** follow the terminal palette via `RGBA.fromIndex` (1 love, 2 pine,
  3 gold, 4 foam, 5 iris, 8 muted) with Rosé Pine hex fallbacks.
- **Keys in the modal** are registered with `ctx.keymap.layer` inside the
  component (priority 10, mode `global`), so they disappear when it closes.
  The open command `auto-mode.open` uses `options.keybind` (default
  `<leader>d`); `cli.json` can override it by ID.
- **Settings rows** go through one `activate(index)` in `tui.tsx`, used by
  `space`, `enter` and mouse clicks: toggle, model picker, or the row's action.
  `enter` returns `false` outside the settings view so OpenCode keeps it.
  `h`/`l` (`sideways`) only change values and skip picker/action rows.
- **Survive hot reloads.** Editing any plugin file reloads it in the running
  server, and the reload can pair a new `index.ts` with an older copy of a
  `src/*` module. Give every new option or state field a fallback where
  `index.ts` reads it (see `alikeTools`, `state.always ??= []`), and keep shared
  state on `globalThis.__opencodeAutoMode`. Restart OpenCode after larger changes.
- **Don't shadow Solid imports** in components: the sidebar's local `on()` once
  hid `on` from `solid-js` (now imported as `track`) and crashed the slot.
- **Modal keys:** `j k g G ctrl+d ctrl+u` scroll, `h l` change the selected
  call's mode (decisions) or value (settings), `a` allowed-only filter, `o` open the origin of an allow, `c` settings, `y` yolo, `-` on/off.
- **Allow origin.** The row an allow is set on (modal or "always" on a prompt)
  keeps an exact `allow` override; `state` sends it as `allowOrigin`. The `a`
  filter shows only those rows, newest per command. Rows merely covered by a
  whole-tool allow show `allow` via `modeFor` but are not origins. Removing a
  whole-tool allow clears every marker of that tool (`clearToolAllows`).
- **Allowed by.** A record allowed by a whole-tool allow or an alike rule gets
  `allowedBy` (action + subject of the origin call). The alike question asks for
  `ALIKE <n>` so `parseAlike` knows which entry matched. The modal shows it
  under the command; `o` or a click selects the newest row with that command.

## Testing

```sh
podman run --rm -v ~/.config/opencode/configured-plugins/auto-mode/src:/app/src:ro -w /app docker.io/oven/bun:1 bun test
```

Type check: install `@opencode/plugin@2.3.0 @opencode/theme@2.3.0
@opentui/core @opentui/solid solid-js@1.9 typescript @types/node` in a
throwaway container (solid-js **1.9**, not 2.x) and run `tsc` with
`jsxImportSource: "@opentui/solid"`, `allowImportingTsExtensions`.

## Known gaps

- Reviews on sessions whose model is on another provider than the reviewer use `generate.text`:
  no cost reported and no system/user split for caching.
- "Always allow" on a prompt does the same as `allow` in the modal, session-only.
  A whole-tool allow is not stored per row: `modeFor` shows it on every row of
  that tool, and setting any of them back removes it. OpenCode still saves its own
  approval for the project, but auto mode overrides `event.effect`, so that never skips review.
- `shell.ts` is a heuristic splitter. When unsure it must mark a command
  `dynamic` or `writes` so it goes to review.
- A TUI hot reload leaves the old copy's `changed` listener behind, so each
  update is handled once per reload until the TUI restarts. Harmless, just extra work.
- An `execute` (Code Mode) call is reviewed as one action: its subject is
  `inside execute: <code>`, not each inner tool call.

## Subagents

- Starting one (`subagent` / `task`) is an instant allow: the check carries
  only the agent ID, never the task, so there is nothing to review.
- Calls *inside* a subagent: records, overrides, caches, denial counts and
  cost belong to the root session. The review runs on the subagent's own
  session, and `ReviewRequest.mainTranscript` adds the root session's
  transcript with a note that the subagent's "USER" is the main agent, not the
  human.

## UI list filtering

With yolo on, the list hides only edits that **yolo itself allowed**
(`record.edit && record.source === "yolo"`). Edits that went to review
(dotfiles, outside the project) stay visible. `sensitivePath` only matches dot
segments that look like names (`DOT_NAME`), and jq/yq/xq's first plain argument
is a filter, not a path, so `jq .time file` stays instant.
