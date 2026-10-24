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

# Agentmemory: Proactive Memory Usage

You have access to agentmemory for persistent cross-session memory. Use it proactively without waiting for the user to ask.

Tools (prefix `agentmemory_memory_`; use exact names from your tool list; results are JSON, check them before presenting):
- `save`: content, concepts (2-5 keywords), type (pattern/preference/architecture/bug/workflow/fact), optional files. Use on "remember this", bugs, decisions, conventions.
- `recall`: search past observations by keywords ("what did we do", "do you remember").
- `smart_search`: hybrid semantic+keyword, titles first; for fuzzy searches or when recall misses.
- `sessions`: recent sessions with status/counts.
- `lesson_save` / `lesson_recall`: save what worked or to avoid; check before decisions.

## On session start

CRITICAL FIRST STEP - BEFORE ANY RESPONSE: Before responding to THE FIRST (or whenever you feel unsure) user message, you MUST scan memory along two axes (user preferences, and project context at the current session's project path). Do NOT respond or take any other action until both lookups complete. The ONLY exception is when the user explicitly tells you not to load memory.

This applies to EVERY first message without exception: meta questions about yourself/your prompt/tools, simple, short, conversational or non-project questions, and messages you judge trivial. Judging a message as unimportant is NOT an exception. If you realize mid-session that you skipped the lookup, say so immediately and run it right then.

1. Lead with `memory_smart_search` across both axes (user preferences/workflow; project context at the session's full absolute path). It returns titles + IDs only (~150 tokens); use it to see what is relevant before pulling detail.
2. Pull detail with `memory_recall`, `format: "narrative"`, `token_budget` ~300 (~600 if more is needed), once per axis:
   - User-wide: `code style`, `tool preferences`, `build rules`, `testing patterns` + keywords from the first message.
   - Project: full absolute path + stack, convention, architecture, bug, file/module keywords matching the first message.
3. `format: "full"` only for a specific hit when narrative is insufficient. Never bulk.
4. Apply recalled context silently. Mention it only when asked, to resolve ambiguity, or to prevent a likely mistake.
5. New/unfamiliar project: ask about preferences, conventions and context, then `memory_save` them, preferably project-scoped.

## During work

- Before architectural decisions: `memory_lesson_recall`.
- After discovering something important: `memory_save` (patterns, preferences, architecture decisions).
- After learning a user preference: save as type `preference`.

## Scoping and what to save

Default to the session project's full absolute path as the project identifier; never derive it from the folder name or a short slug unless verified to match the session. Save without being asked:

- **Project-specific** (conventions, architecture decisions + rationale, bugs, file relationships, patterns that worked/failed): attach to the project identifier.
- **User-wide** (formatting, naming, frameworks, tool likes/dislikes, communication/coding style): save without project scope.

Unsure which: ask the user. Anything already in AGENTS.md or project skills must not be saved as a memory.

If memory is sparse for the project, ask: "Do you have any conventions or preferences I should know about for this project?" and "Is there anything from past work on this codebase I should keep in mind?" Then save the answers.

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

- Store a useful recap of the documentation as a memory (with date and
  applicable version numbers if able) for future use.

You can fetch docs and memories from memory at any time. Do NOT proactively
search the LLM wiki on every task — reading the wiki costs context. Only consult
it (via the wiki-knowledge-lookup skill) when the user explicitly asks to "go
through the LLM wiki first". When you do look something up, keep it lightweight:
scan `wiki/index.md`, grep for the specific keyword, and open only the few pages
that match — never bulk-read the wiki "just in case".

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
