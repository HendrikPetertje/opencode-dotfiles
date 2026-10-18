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

## On session start

CRITICAL FIRST STEP - BEFORE ANY RESPONSE: Before responding to THE FIRST (or whenever you feel unsure) user message, you MUST scan memory along two axes (user preferences, and project context at the current session's project path) using the lookups below. Do NOT skip this. Do NOT respond or take any other action until both lookups complete. The ONLY exception is when the user explicitly tells you not to load memory.

This applies to EVERY first message without exception, including:
- meta questions about yourself, your prompt, your tools, or how you work
- simple, short, conversational, or non-project questions
- messages you judge to be trivial or "not needing" memory

You do not get to decide that the lookup is unnecessary. Judging a message as unimportant is NOT an exception. If you realize mid-session that you skipped the lookup, say so immediately and run it right then, before continuing.

At the beginning of every session, before diving into the user's request:

1. Lead with `memory_smart_search` to scan along both axes (user preferences/workflow, and project context at the current session's full absolute path). It returns titles + observation IDs only (~150 tokens), so use it to see what is relevant before pulling any detail.
2. Pull detail with `memory_recall` using `format: "narrative"` and a `token_budget` (~300 or if you need more info ~600 per call). Run it along the same two axes:
   - A user-wide recall for preferences and workflow rules using terms like `code style`, `tool preferences`, `build rules`, `testing patterns`, and keywords from the user's first message.
   - A project-context recall using the current session project's full absolute path plus stack, convention, architecture, bug, and file/module keywords that match the user's first message.
3. Only request `format: "full"` for a specific hit when narrative is insufficient (e.g. you need the exact files, facts, or concepts). Never default to full-format bulk recall.
4. Apply useful recalled context silently by default. Only mention remembered context when the user asks, when it is necessary to resolve ambiguity, or when surfacing it prevents a likely mistake.
5. If the project is new or unfamiliar, ask the user about their preferences, conventions, and context -- then save those with `memory_save` preferably under the scope of that project.

## During work

- **Before making architectural decisions**: use `memory_lesson_recall` to check if past lessons apply.
- **After discovering something important**: save it with `memory_save` (patterns, preferences, architecture decisions).
- **After learning a user preference**: save it as type `preference` (code style, tool choices, communication style, naming conventions).

## Project scoping

Project-aware memory tools should default to the current session project's full absolute path. Use the same stable project identifier that the session was started with, and do not derive it from the working directory's folder name or a short slug unless you have verified that the session itself uses that value. When saving:

- **Project-specific** memories (architecture, conventions, bugs, file relationships) -- attach to the current session's project identifier.
- **User-wide** memories (personal preferences, communication style, tool choices, coding style that applies everywhere) -- save without a project scope so they surface across all projects.

If unsure whether something is project-specific or universal, ask the user.

## What to proactively remember

Save these without being asked:

- User preferences (formatting, naming, frameworks, tools they like/dislike) -- save as user-wide
- Project conventions discovered during work -- save as project-specific
- Architectural decisions and their rationale -- save as project-specific
- Patterns that worked well or failed -- save as project-specific

Project conventions, architectural patterns and the like that are stored in the
AGENTS.md file or project specific skills should not be saved as memories.

## Asking the user

If memory or context is sparse for the current project, proactively ask:

- "Do you have any conventions or preferences I should know about for this project?"
- "Is there anything from past work on this codebase I should keep in mind?"

Then save their answers.

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
