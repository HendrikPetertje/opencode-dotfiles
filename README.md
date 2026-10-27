# OpenCode config

Personal [OpenCode](https://opencode.ai) configuration, version-controlled for portability across machines.

## Prerequisites

- Node.js / npm
- [Podman](https://podman.io/) (containerized MCP servers use Podman, not Docker)
- A secrets manager (e.g. [1Password](https://1password.com/)) that mounts env files with conditional access

## Installation

Copy the lines below to your .zshrc / .bashrc / etc.

Install OpenCode and its companion tools:

```bash
function install_opencode() {
  echo "Installing opencode itself"
  npm install -g opencode-ai
  echo "Installing openspec"
  npm install -g @fission-ai/openspec@latest
  echo "Installing open-ai codex auth"
  npx -y opencode-openai-codex-auth@latest

  echo -e "please run the following command to authenticate to github & openAI plus (if needed)\nopencode auth login"
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

### ENV variables

Your secrets env file should export the following keys:

```bash
ANTHROPIC_API_KEY=
OPENCODE_FAST_MODEL=
OPENCODE_BIG_MODEL=
AIM_GLOBAL_PATH=
CONTEXT7_API_KEY=
GITHUB_PERSONAL_ACCESS_TOKEN=
JIRA_TOKEN=
JIRA_BASE_URL=
CONFLUENCE_TOKEN=
CONFLUENCE_BASE_URL=
CONFLUENCE_DEFAULT_SPACE=
NOTION_API_TOKEN=
TAVILY_API_KEY=
REF_MCP_API_KEY=
OBSIDIAN_API_KEY=
NOTION_EXJOBB_API_TOKEN=
```

OpenAI authentication is handled by the `opencode-openai-codex-auth` OAuth plugin, so no `OPENAI_API_KEY` is needed (if you want to use your chatgpt-plus plan).

### tui.json

Custom keybindings: leader key is `ctrl+o`, submit with `enter`, newline with `alt+enter` or `ctrl+j`.

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
| `memory` | Local (npx) | Persistent AI memory via knowledge graph |
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

## Memory system

Agents use AIM (AI Memory), a persistent knowledge graph backed by the `memory` MCP server (`mcp-knowledge-graph`). Instructions live in `AGENTS.md`.

- **Global** and **project** scopes are both always read and written explicitly by the agent
- Where each scope is stored is decided by the `--memory-path` argument of the `memory` server in `opencode.jsonc` (`~/.config/.aim/`), not by the agent

---

Last updated at commit `a4b87de`.
