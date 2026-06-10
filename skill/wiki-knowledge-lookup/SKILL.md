---
name: wiki-knowledge-lookup
description: Load ONLY when the user explicitly asks to consult the LLM wiki first — e.g. "please go through the LLM wiki first", "check the LLM wiki", "use the wiki". Do NOT load proactively for general research, documentation lookups, or context7/tavily/web searches. Once loaded, it consults the local LLM Wiki at $LLM_WIKI_PATH (a curated, cross-linked knowledge graph: concept/source-summary/person pages in wiki/, immutable sources in raw/), falls back to external search and local dependency dives only when the wiki lacks detail, then writes useful dependency findings back into the wiki raw/ folder. Requires LLM_WIKI_PATH to be exported.
license: MIT
compatibility: opencode
---

# Wiki Knowledge Lookup

Load this skill only when the user explicitly asks to go through the LLM wiki
first (see the description for trigger phrasing). Once loaded, the local LLM
Wiki at `$LLM_WIKI_PATH` is a curated, cross-linked knowledge graph maintained
by AI agents (see its own `AGENTS.md` for the domain it covers) — the **first**
place to look before any external search, holding curated, cited,
project-internal knowledge that no external tool and no amount of model training
contains.

Flow: **gate → wiki first → fallback → store.** The Quick reference table
at the bottom is the canonical summary; the sections below are the detail.

## Gate — check `LLM_WIKI_PATH` first

This skill is inert unless `LLM_WIKI_PATH` is exported.

```sh
echo "${LLM_WIKI_PATH:-<not set>}"
```

- **Unset**: there is no wiki. Skip every step below, research normally
  (external search / dependency dives), and do not write back to llm wiki. You are done with
  this skill.
- **Set**: it is the wiki root. Layout:
  - `./wiki/index.md` — table of contents (read this first)
  - `./wiki/*.md` — concept, source-summary, and person pages, cross-linked with
    `[[wiki-link]]` syntax
  - `./raw/*.md` — immutable source documents (read-only)
  - `./wiki/log.md` — append-only operations log

One judgment call the description can't make for you: if the topic is purely
generic public knowledge with no internal angle (e.g. a standard-library
function), a full wiki search may not pay off — but an `index.md` scan is cheap
and often surfaces an internal convention you'd otherwise miss.

## Step 1 — Search the wiki

1. **Read `wiki/index.md`.** It is the table of contents — pages grouped by
   category (systems, teams, processes, people, sources, …), each with a
   one-line description. Use it to pick candidate pages — do not load unrelated
   pages.
2. **Open the candidate pages** and follow their `[[wiki-links]]` to related
   concepts, source summaries, and people.
3. **Grep the body when the index is ambiguous** (function names, acronyms,
   system names):

   ```sh
   grep -ril "<keyword>" "$LLM_WIKI_PATH/wiki"
   ```

4. **Open the matching `raw/` source** only when a `source-*` page points at it
   and you need detail the summary omits.

### Is the wiki answer enough? Ask:

- Does a relevant concept / source / person page actually exist (not just a
  passing mention)?
- Do the facts I need carry `(source: ...)` citations?
- Is what I need free of blocking `[needs verification]` flags or noted
  contradictions?

**All yes** → answer from the wiki and cite the pages you used by name (e.g.
`[[page-name]]`). **Any no** (no page, a stub, missing the specific
API/behaviour/steps, or unverified) → go to Step 2.

## Step 2 — Fall back: external search or dependency dive

Pick the source that fits the gap:

- **Public docs** (libraries, frameworks, public APIs, current events):
  `context7` for versioned library docs; otherwise `tavily` / web. Prefer a
  docs-specific tool over generic web search.
- **Dependency dive** (how the *installed* package actually behaves — types,
  internal helpers, vendored code): read the real source on disk —
  `node_modules/<pkg>`, Python `site-packages`, vendored dirs, lockfiles,
  `*.d.ts`, package READMEs. For the exact installed version this beats external
  docs. Record the version you inspected (`package.json`, lockfile,
  `__version__`) so the finding stays trustworthy.

Internet docs pulled via context7 / fetch / confluence follow the global
AGENTS.md "Docs memories & WIKI" rule (store to `raw/` + memory recap) — the
same Step 3 storage rules apply to dependency findings.

## Step 3 — Storing things in the LLM wiki

Two very different situations. Decide which one you're in **before** writing
anything:

```sh
# Are you working directly on the wiki, or pushing into it from elsewhere?
[ "$(cd "$LLM_WIKI_PATH" && pwd -P)" = "$(pwd -P)" ] && echo "INSIDE wiki" || echo "OUTSIDE wiki"
```

### Case A — Pushing in from another project (cwd is NOT the wiki)

This is the normal case: you found something useful while working in some other
repo and want it to survive in the wiki. **You may only add a new file under
`raw/`. Nothing else.**

- Allowed: create `$LLM_WIKI_PATH/raw/[YYYY-MM-DD]-[slug].md` (a dated note) +
  a `memory_save` recap.
- Not allowed: creating or editing anything in `wiki/` (concept/source/person
  pages), `index.md`, or `log.md`. Curating raw material into wiki pages is a
  human-guided ingest step — do it only with the user, or *offer* and wait.

Write the raw note only when the finding is non-obvious and version-specific
(e.g. a dependency dive turned up an undocumented helper, a type contract, a
gotcha). For the exact frontmatter, filename rule, and recap step:

**MANDATORY — READ ENTIRE FILE**: before writing, read
[`references/raw-note-template.md`](references/raw-note-template.md) in full.

**Do NOT load that template during Steps 1–2** — it is only for the write path.

### Case B — Working directly on the wiki (cwd IS the wiki)

The user has opened the wiki itself and is curating it. The `raw/`-only
restriction above does **not** apply here — editing `wiki/` pages, `index.md`,
and `log.md` is the actual job. Follow the wiki's own `AGENTS.md` ingest
workflow (read the source, discuss takeaways, create/update concept pages with
`[[wiki-links]]`, update `index.md`, append to `log.md`). This skill defers to
that `AGENTS.md` entirely in Case B.

## NEVER (and why)

- **NEVER modify anything in `raw/`** — those are immutable source documents.
  Only *add* new dated notes.
- **When pushing in from another project (Case A), NEVER edit `wiki/` pages,
  `index.md`, or `log.md`.** Curating raw material into the wiki is a
  human-guided ingest step. Deposit the raw note + memory recap, then *offer* to
  run ingestion — don't perform it unprompted. (This bullet does not apply in
  Case B, when the wiki itself is the working directory.)
- **NEVER treat a stub or a `[needs verification]`-flagged page as sufficient.**
  It reads as an answer but isn't cited — escalate to Step 2 instead of
  presenting unverified claims as fact.
- **NEVER write a raw note for trivial or well-known findings.** `raw/` is for
  non-obvious, version-pinned discoveries; routine facts dilute future `grep`
  and waste the curator's attention.
- **NEVER dump `index.md` wholesale or open large `raw/` files "just in case."**
  Scan the index, then grep for candidates, then open only what matches. Context
  is shared budget.

## Quick reference

| Phase | Action | Guard |
|-------|--------|-------|
| Gate | `echo $LLM_WIKI_PATH`; if unset, skip the wiki and research normally | env var |
| 1. Wiki first | `wiki/index.md` → open candidates → follow `[[links]]` → grep `wiki/` → matching `raw/` | when set |
| Judge | Page exists + cited + no `[needs verification]`? Answer & cite. Else → Step 2 | — |
| 2. Fallback | context7 / tavily / web for public docs; dive `node_modules` / site-packages for installed behaviour (note the version) | — |
| 3. Store | Pushing in from elsewhere → `raw/[date]-[slug].md` + `memory_save` ONLY (never `wiki/`). Working on the wiki itself → follow its own AGENTS.md ingest workflow | env var |
