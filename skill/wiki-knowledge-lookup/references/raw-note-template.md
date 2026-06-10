# Dependency-dive raw note template

Use this when a dependency dive surfaced something worth keeping. Write the file
to `$LLM_WIKI_PATH/raw/[YYYY-MM-DD]-[short-slug].md` (lowercase, hyphenated
slug, today's date). Copy the block below verbatim and fill the `<...>` fields.

```markdown
---
title: "<what this finding is about>"
source: "<package@version, file path, or upstream URL>"
author: <upstream author if known, else delete this line>
published: <upstream date if known, else delete this line>
created: <YYYY-MM-DD>
description: "<one-line summary>"
tags:
  - too-dependency-dive
  - <package-or-system-name>
---

# <Finding title>

**Package / location**: `<pkg@version>` — `<exact path inspected>`

**Discovered**: <YYYY-MM-DD>, during <brief task context>

## What was found

<The actual finding: behaviour, signature, gotcha, code excerpt. Paste the
relevant source verbatim where it helps — raw/ is for source material, so a
real excerpt is more valuable than a paraphrase.>

## Why it matters

<When this is relevant; what it unblocks or warns against in future work.>
```

## Field notes

- **`source`** must pin the version (`pkg@1.4.2`) or the exact file path. A
  finding without a version is untrustworthy six months later.
- **`tags`**: always `too-dependency-dive` (mirrors the global AGENTS.md
  `too-[tool]` convention) plus one system/package tag so the note is findable
  by `grep`.
- **Delete** the `author`/`published` lines rather than leaving them blank or
  set to "unknown" — empty frontmatter keys are noise.
- One finding per note. If a dive turned up three unrelated things, write three
  notes (or group only if they're genuinely one topic).

## After writing the note

Save a memory recap with `memory_save` (type `fact`): what was found, the
`package@version`, the file path, and this note's filename. The raw note is the
durable artifact; the memory recap is what makes it surface in future sessions
without a `grep`.
