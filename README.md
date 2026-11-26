# OpenCode config

Personal [OpenCode](https://opencode.ai) configuration, version-controlled for portability across machines.

## Prerequisites

- Node.js / npm
- [Podman](https://podman.io/) (containerized MCP servers use Podman, not Docker)
- A secrets manager (e.g. [1Password](https://1password.com/)) that mounts env files with conditional access

### CLI tools (Homebrew)

Agents rely on these command line tools (see `AGENTS.md`). Install them all on a new machine with:

```bash
brew install ripgrep the_silver_searcher fd jq yq xq miller duckdb ast-grep tokei
```

| Formula | Binary | Purpose |
|---------|--------|---------|
| `ripgrep` | `rg` | Fast content search |
| `the_silver_searcher` | `ag` | Content search |
| `fd` | `fd` | File finder (use instead of `find`) |
| `jq` | `jq` | JSON processing |
| `yq` | `yq` | YAML/TOML/XML processing |
| `xq` | `xq` | XML/HTML queries (conflicts with `python-yq`) |
| `miller` | `mlr` | CSV/TSV/JSON records |
| `duckdb` | `duckdb` | SQL over CSV/JSON/Parquet |
| `ast-grep` | `ast-grep` | Structural code search and rewrite |
| `tokei` | `tokei` | Code size and language stats |

Verify with `command -v rg ag fd jq yq xq mlr duckdb ast-grep tokei`.

## Installation

Copy the lines below to your .zshrc / .bashrc / etc.

Install OpenCode and its companion tools:

```bash
function install_opencode () {
  echo "Removing old opencode install (if present)"
  npm uninstall -g opencode-ai 2> /dev/null
  echo "Allowing opencode postinstall script to run (idempotent)"
  npm config set allow-scripts="@opencode/cli" --location=user
  echo "Installing opencode itself"
  npm install -g @opencode/cli
  echo "Ensuring opencode postinstall actually ran"
  npm rebuild -g @opencode/cli 2> /dev/null
  echo "Installing openspec"
  npm install -g @fission-ai/openspec@latest
  echo 'DONE'
}
```

Create a wrapper that loads secrets before launching OpenCode:

```bash
function opoc() {
  (
    set -a
    source /location/of/env/file
    set +a
    command opencode "$@"
  )
}
```

The `source` path should point to wherever your secrets manager (1Password, etc.) mounts env files. Users will be prompted for access when the file is sourced.

Then clone this repo and run `opoc`:

```bash
git clone https://git.hendrikpeter.net/hendrikpeter/opencode-dotfiles.git ~/.config/opencode
opoc
```

On first launch, OpenCode auto-generates `package.json` and installs plugin dependencies automatically — no manual `npm install` needed.

## What's tracked

`package.json` and `package-lock.json` are not version controlled. they will be
created automagically on first run and updated as you install plugins and MCP servers.

## Configuration


### cli.json

Terminal UI settings and keybindings: leader key is `ctrl+o`, submit with `enter`, newline with `alt+enter` or `ctrl+j`. Plugin shortcuts: `<leader>k` / `<leader>shift+k` (project / global memory), `<leader>d` (auto-mode decisions).

## Agents

The default agent is `plan` (read-only). Switch to `pevaBuild` for write access.
This repo does specify other Agent's though. If you are running on Claude, then
pevaBuild and pevaPlan will have a slightly better prompt that also includes
memory management instructions.


| Agent | Role | Tools |
|-------|------|-------|
| `dev/pevaBuild` | Primary coding agent | Full access, memory management |
| `dev/pevaPlan` | Planning agent (default) | Read-only, no edits |
| `dev/explore` | Codebase search | File search only, no writes |
| `dev/review` | Code quality review | Read-only, no bash |
| `dev/security-auditor` | OWASP security auditing | Read-only, no bash |
| `other/general-researcher` | Non-dev research | Web fetch, no code tools |
| `other/writer` | Documentation, prose, READMEs, blog posts | Read-only, no bash, no code |

The build and plan agents delegate to the subagents (`explore`, `review`, `security-auditor`) as needed.

## Skills

Skills are loaded on demand when a task matches their description.

| Skill | Purpose |
|-------|---------|
| `caveman` | Ultra-compressed communication mode — drops filler, articles, hedging. Multiple intensity levels including wenyan (文言文) |
| `humanizer` | Strips AI writing patterns from text |
| `mermaid-diagrams` | Mermaid diagram syntax guide with references |
| `skill-judge` | Evaluates SKILL.md quality (120-point rubric) |
| `writing-clearly-and-concisely` | Strunk & White rules for clear prose |
| `content-research-writer` | Research-backed content writing workflow |

## Slash commands

| Command | Description |
|---------|-------------|
| `/caveman` | Activates caveman communication mode |
| `/caveman-compress` | One-shot caveman-style context compression |

## MCP servers

### Enabled by default

| Server | Type | Description |
|--------|------|-------------|
| `context7` | Remote | Library documentation lookup |
| `memory` | Local (npx) | Persistent AI memory via knowledge graph (registered by the `memory-ticker` plugin, not in `opencode.jsonc`) |
| `sequentialthinking` | Local (Podman) | Structured reasoning |
| `time` | Local (Podman) | Timezone operations |

### Disabled (opt-in)

| Server | Type | Notes |
|--------|------|-------|
| `confluence` | Local (Podman) | Requires `CONFLUENCE_*` env vars |
| `jira` | Local (Podman) | Requires `JIRA_*` env vars |
| `notion` | Local (Podman) | Requires `NOTION_API_TOKEN` |
| `github` | Remote | Requires `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `playwright` | Local (npx) | Browser automation |
| `chrome-devtools` | Local (npx) | Chrome debugging |
| `exa` | Remote | Web search, requires `EXA_API_KEY` |
| `tavily` | Remote | Web search, requires `TAVILY_API_KEY` |
| `sanity` | Remote | CMS, requires `SANITY_MCP_TOKEN` |
| `fetch` | Local (Podman) | HTTP fetch |
| `calculator` | Local (Podman) | Calculator |
| `aws-knowledge-mcp-server` | Remote | AWS documentation |
| `gh_grep` | Remote | **Disabled for security reasons** — results are uncurated and contain LLM injection traps |

To enable a disabled server, set `"enabled": true` in `opencode.jsonc`.

## Plugins

OpenCode auto-loads every directory under `plugins/`, but **without options**.
Plugins that need options therefore live in `configured-plugins/` and are
registered with their options in `opencode.jsonc` (keeping them in `plugins/`
would load a second, unconfigured copy).

### Configured (`configured-plugins/`, registered in `opencode.jsonc`)

| Plugin | What it does |
|--------|--------------|
| `memory-ticker` | Registers the `memory` MCP server (option `globalPath`: where global memory lives, `~/.config/.aim`) and adds a footer widget with entity/observation/relation counts for global and project memory. Click a segment, or `<leader>k` / `<leader>shift+k`, to browse the memories. |
| `auto-mode` | Claude Code style auto mode: a reviewer model (`github-copilot/claude-haiku-5.5`) approves, denies or asks on each permission check, so you're only asked when it matters. Sidebar list of decisions with reviewer cost, a decisions/settings modal (`<leader>d`, `/auto-mode`), vigilance after a deny, dotfiles never read without review. See `configured-plugins/auto-mode/README.md`; agents working on it should read its `OUTLINE.md` first. |

auto-mode reads extra reviewer rules from `AUTO_MODE_INSTRUCTIONS.md` in this
folder (global) or a project's `.opencode/` (per project). Its decision log and
error log are in `~/.local/state/opencode-auto-mode/`.

### TUI-only (`configured-plugins/`, registered in `cli.json`)

| Plugin | What it does |
|--------|--------------|
| `opencode-vim` | Fork of `opencode-vim`: Vim editing in the prompt plus a Vim command line in the footer. `:` in NORMAL runs slash commands (`:models`, `:exit`, Tab cycles completions); in VISUAL it opens `:'<,'>` for `s/pat/rep/g`, `d`, `y`, `sort`, `!cmd` and `send`. `%s/…` edits the whole prompt. In SESSION mode `/` searches what is on screen, `/!` the whole loaded transcript; `n` / `N` step older / newer. |

### Auto-loaded (`plugins/`, no options)

| Plugin | What it does |
|--------|--------------|
| `gemma-think` | Makes Gemma 4 thinking blocks show up correctly (LM Studio) |

## Memory system

Agents use AIM (AI Memory), a persistent knowledge graph backed by the `memory` MCP server (`mcp-knowledge-graph`). Instructions live in `AGENTS.md`.

- **Global** and **project** scopes are both always read and written explicitly by the agent
- The `memory` server is registered by the `memory-ticker` plugin; global memory is stored where its `globalPath` option points (`~/.config/.aim/`), project memory in a project's `.aim/` folder

---

Last updated at commit `9fca87aa`.
