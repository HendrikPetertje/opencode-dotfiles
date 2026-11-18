# auto-mode

An OpenCode V2 plugin in the spirit of
[Claude Code's auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode):
a reviewer model approves, denies or hands back to you each permission check,
so you only get asked when it matters.

Based on the ideas in
[mellena1/opencode-auto-mode](https://github.com/mellena1/opencode-auto-mode).

## Setup

Add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  {
    "package": "./configured-plugins/auto-mode",
    "options": {
      "model": "github-copilot/claude-haiku-5.5"
    }
  }
]
```

`model` is required. Without it, auto mode still does its instant checks, but
everything that needs a review is left to you.

## How it decides

For each permission check, in this order:

1. **Off**: OpenCode's own rules apply.
2. **Your own rules win.** If `opencode.jsonc` has a rule for that specific
   tool or command (for example `context7_*: ask`), OpenCode decides. Only what
   falls under a catch-all `*` rule is up to auto mode.
3. **Your choices for this session**: deny, check or allow on a call in the
   modal. "Always allow" on a prompt is the same as allow. Both last for this
   session only:
   - **allow tool**: for MCP and other ordinary tools, every call to that tool
     is allowed, whatever its input.
   - **allow alike**: for the tools in the `alikeTools` option (default
     `shell`, `execute`, `webfetch`, `read`, `grep` and `glob`, where the
     input is everything), the reviewer compares later calls
     with the one you allowed (and what you were asking for then), judging a
     command chain as a whole. Alike calls are allowed; anything else gets the
     normal review. Skipped while on guard.
4. **Instant rules**: read-only tools and commands (`ls`, `rg`, `git status`,
   pipes of those) and starting a subagent are allowed; catastrophic commands
   (`sudo`, `rm -rf /`, `mkfs`) are denied; file edits inside the project are
   allowed in yolo mode, except dotfiles (`.envrc`, `.git/hooks`, CI workflows,
   `.opencode/`). **Reading a dotfile or secret file is never instant**:
   any path with a part starting with `.` (`.env`, `~/.aws/…`, `.npmrc`,
   `.config/gh/…`) or a secret-looking name (`*.pem`, `*.key`, `id_rsa*`,
   `credentials`, `secrets.*`) goes to review, whether through `cat`/`rg`/… or
   the `read` tool. Once read, a secret sits in the model's context and the
   provider's logs, so the reviewer checks whether the task needs it.
5. **The reviewer model** checks everything else: a quick one-word check first,
   and a full review only when that flags something (anything outside the
   project, near a block rule, or when you asked to be asked). The full review
   answers:
   - **deny** only when a block rule matches: destroying or exfiltrating data,
     credentials, persistence, weakening security, pushing to main, and so on
   - **ask** (the normal permission prompt, with the reason attached) for real
     side effects outside the project that you didn't ask for, or when you asked
     to be asked
   - **allow** for ordinary work in the project and anything you asked for

After 3 denials in a row (or 20 in a session) you're asked instead. A command
the reviewer refused stays refused until you send a new message.

### Vigilance after a deny

A deny usually means the agent will try the same goal another way. So after any
deny, the next **10 reviewed calls** in the session are on guard:

- every one gets the full review (no quick check, no "allowed this before")
- the reviewer sees the last 3 denied commands and why, and is told to watch for
  workarounds
- every new deny starts the count at 10 again

The shield turns gold while on guard, and the modal header shows how many
guarded reviews are left. **Reset vigilance mode** in settings ends it early.

### Subagents

- Starting a subagent is instant: the check only names the agent, not its task.
- Every call a subagent makes is reviewed like your own, and shows up in the
  main session's list. Your choices, approvals, vigilance and cost are shared
  with the main session.
- The reviewer then also sees your messages from the main session, and is told
  that the subagent's "user" is the main agent, not you.

### What the reviewer sees

- The full command, as the agent wrote it, including pipes
- Your last 10 messages and the tool calls since (never the agent's own text
  or tool output, so injected instructions can't talk it into anything)
- The global and project `AGENTS.md`
- Your global and project memory (`.aim` knowledge graph)
- `AUTO_MODE_INSTRUCTIONS.md` from `~/.config/opencode/` and the project's
  `.opencode/`, always, after everything else. Write instructions for the
  reviewer here, for example "pushing to feature branches is fine". It's read
  fresh on every review, so you can edit it mid-session.

### Cost

Reviews run as one-off calls on your own session: no extra sessions, nothing
added to the history. The fixed part of the prompt (rules, memory, your
instructions) is sent as the system prompt, so providers can cache it.

The sidebar shows the session's reviewer cost next to "Auto mode"; the modal's
top-right adds the number of reviews and how much was cached. This only works
when the reviewer is on the **same provider** as the chat model (the settings
view warns when they differ). Otherwise reviews still work but report no cost,
and the total gets a `+`.

## Using it

- **Sidebar**: the shield, "Auto mode", a pencil when yolo is on, the cost, and
  the last 5 tool calls with their decision (a spinner while one is being
  reviewed). Click a row or "… more" to open the modal.
- **Footer icon**: shown when the sidebar is hidden. Click it to open the modal.
  It spins while a review runs, is gold while on guard and grey when auto mode is off.
- **Why you're asked**: when auto mode hands a call back to you, a gold block
  above the prompt shows its reason while the permission prompt is open.
- **`<leader>d`** or `/auto-mode` opens the modal.

In the modal:

| Key | Does |
|---|---|
| `j` `k` `g` `G` | scroll |
| `h` / `l` | toggle mode: what happens to this command for the rest of the session (deny · check · allow) |
| `a` | filter: only the calls you set allow on (newest per command), hiding the calls they allowed later; press again for all |
| `o` | jump to the call whose allow covered the selected one |
| `c` | settings (and back) |
| `y` | file yolo on/off |
| `-` | auto mode on/off |
| `esc` | close |

"Allow" shows as **allow tool** or **allow alike**, depending on the tool (see
above). The line under the modes says which. Press `a` to see only the calls
you allowed. A call that was allowed because of one of them shows **allowed
by: …** under its command; press `o` or click it to jump to that call. To undo
an allow, set its call back to check or deny.

In settings, move with `j` / `k`; `space`, `enter` or a click toggles a setting, opens the model picker or runs the action; `h` / `l` change values:

| Setting | |
|---|---|
| Reviewer model | `space` opens the model picker |
| Global AGENTS.md / Project AGENTS.md | send them to the reviewer |
| Global memory / Project memory | send them to the reviewer |
| Recent messages | how many of your messages the reviewer sees (`h` / `l`) |
| Review | `all`, or `prompts` to only review what would otherwise ask you |
| Reset vigilance mode | shows the guarded reviews left; `space` ends it for this session |

Settings are remembered per project; on/off and yolo are remembered everywhere.

## Options

| Option | Default | |
|---|---|---|
| `model` | required | `"provider/model"`; the default reviewer. Pick another per project in settings (space on **Reviewer model**). Keep it on the same provider as your chat model: only then are reviews priced and cached. |
| `messages` | `10` | how many of your recent messages the reviewer sees |
| `includeAgentsMd` | `true` | `true`/`false`, or `{ "global": true, "project": false }` |
| `includeMemory` | `true` | same shape |
| `memoryDir` | `"~/.aim"` | global memory directory |
| `memoryFile` | `"memory-current.jsonl"` | file name inside `.aim` directories |
| `yoloEdits` | `true` | allow file edits inside the project without review |
| `enabled` | `true` | on/off at first start (the toggle is remembered after that) |
| `review` | `"all"` | `"prompts"` to only review what would otherwise ask you |
| `log` | `true` | write decisions to `~/.local/state/opencode-auto-mode/decisions.jsonl` (latest 1000 kept; **Open log folder** in settings opens it) |
| `keybind` | `"<leader>d"` | opens the modal |
| `alikeTools` | `["shell", "execute", "webfetch", "read", "grep", "glob"]` | tools where "allow" means **allow alike** (reviewer-checked) instead of the whole tool. Wildcards work (`"github_*"`); `[]` makes every allow a whole-tool allow |
| `policy` | built in | `{ "trusted": [], "blocks": [], "exceptions": [] }` replaces the reviewer's rules |

The `includeAgentsMd`, `includeMemory`, `messages` and `review` options set the
defaults; the settings view changes them per project.

## Troubleshooting

- **"auto-mode hit an error, so you decide"**: a check crashed and was handed to
  you, as designed. The cause is in `plugin.log`.
- **After editing the plugin's files**, OpenCode reloads it while it runs. That
  can mix old and new code for a moment (errors, stale sidebar); restart
  OpenCode if anything looks off.
- **"Always allow" didn't stick**: press `a` in the modal to list your allows.
  If it's empty, the reply wasn't stored; `plugin.log` shows why.

## Files

- `decisions.jsonl` and `plugin.log` in `~/.local/state/opencode-auto-mode/`
- `OUTLINE.md` explains the code, for agents working on it
