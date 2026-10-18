# Hard Rules (never violate)

1. **Never run the `find` bash command, in any form, for any reason** (e.g. `find . -name`, `find -maxdepth`, piped into `find`, etc.). This includes as a fallback in `||`/`&&` chains. Use `rg --files -g '<pattern>'`, `ag -g '<pattern>'`, or the Glob tool instead. If you catch yourself about to type `find`, stop and substitute one of those instead.
2. Never commit. GPG signing is enforced on this user's commits and AI agents cannot sign commits, so agents must never run `git commit` themselves — the user handles all commits. When asked, only draft a commit message for the user to copy-paste (see GIT section below).

# Lightweight Explorer
The lightweight-explorer can be used to perform certain tasks outlined below.
Whenever starting the `lightweight-explorer` subagent, read the provider/model
from the `OPENCODE_MINI_MODEL` environment variable and pass it explicitly as
the subagent invocation's `model`. Do not rely on the agent's configured default
model. Based on the task decide if there is value in allowing the sub-agent to
fetch memories. If a sub agent runs a set of pre-determined commands and
summarizes their output, then there is no reason to allow that sub-agent to
fetch 10k tokens worth of memories.

# Images and Binary Data

- Do not inspect images, screenshots, or other binary/non-text assets directly in the primary agent session. Delegate that inspection to a subagent.
- `lightweight-explorer` is the preferred subagent for this work. Ask it for a concise text-only description, transcription, or summary of the relevant content.
- Whenever starting the `lightweight-explorer` subagent, read the provider/model from the `OPENCODE_MINI_MODEL` environment variable and pass it explicitly as the subagent invocation's `model`. Do not rely on the agent's configured default model.
- Do not forward image or binary payloads to the primary agent; use only the subagent's textual findings.

# Controlled Chromium and Playwright

- When a task needs a controlled Chromium or Playwright session, either delegate the entire browser interaction to `lightweight-explorer`, or save snapshots directly to files and ask the subagent to inspect them.
- In the snapshot workflow, do not read or view the snapshot in the primary agent session. Keep browser output to a file path; if a tool would return visual content inline, delegate browser control instead.
- Use only the subagent's text summary of the browser state or snapshot.

# Docs memories & WIKI
IMPORTANT: If you pull documentation, articles, pages or code samples from the internet (using tools like context7, fetch
tool, confluence, etc.) then always do two things with this:

- if LLM_WIKI_PATH is an exported variable in your session, store the file,
  snippet or text as is as a markdown document in `${LLM_WIKI_PATH}/raw/[YYYY-MM-DD]-[filename].md`
  at its top it should have the following properties:

````
---
title: "Title of the document"
source: "https://source"
author: if applicable
published: if applicable
created: 2026-05-11
description: "short description"
tags:
  - "too-[tool-name-you-used]"
---
[ACTUAL DOCUMENT HERE]
````

Do NOT proactively search the LLM wiki on every task — reading the wiki costs
context. Only consult it (via the wiki-knowledge-lookup skill) when the user
explicitly asks to "go through the LLM wiki first". When you do look something
up, keep it lightweight: scan `wiki/index.md`, grep for the specific keyword,
and open only the few pages that match — never bulk-read the wiki "just in
case".

## GIT
- GH cli is installed and logged in. (additionally jq is available too)
- The user has GPG signing on their commits and all commits should be signed.
  Don't commit unless the user explicitly asks you to. write commit message =
  output a commit message the user can copy-paste

# Tooling
- The user has ripgrep, grep and ag (silver searcher) installed. find is often
  an extremely slow way to find things on the disk, especially in nodejs
  projects with many dependencies. DO NOT EVER USE THE "find" BASH COMMAND ON THE
  LOCAL MACHINE, in any form (including `-maxdepth`, `-name`, or as a fallback
  in `||`/`&&` chains). See Hard Rules at the top of this file.
