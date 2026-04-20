---
name: markitdown
description: >
  Convert non-text files to Markdown using the `markitdown` CLI (by Microsoft).
  Supports PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx/.xls), HTML,
  images (EXIF/OCR), audio (transcription), CSV, JSON, XML, YouTube URLs,
  and EPubs. Use this skill whenever the agent needs to read, analyze, or extract
  content from binary or non-plaintext files — e.g. a user shares a .pdf, .docx,
  .pptx, .xlsx, or .html file and asks questions about it, or when piping web
  page content through markitdown would yield better structured context than raw
  HTML. Also use when the user explicitly asks to convert a document to Markdown.
license: MIT
compatibility: opencode
---

# markitdown

`markitdown` is a CLI tool installed on this system that converts documents and rich files into Markdown — ideal for feeding non-text content into LLM context.

## Usage

```bash
# File to stdout (capture or redirect)
markitdown path/to/file.pdf

# File to output file
markitdown path/to/file.docx -o output.md

# Pipe content in
cat page.html | markitdown
```

Output goes to stdout by default. Use `-o <file>` to write to a file instead.

## When to Use

Reach for markitdown when you encounter a file that isn't already plain text or Markdown:

| File type | Extensions / inputs |
|-----------|-------------------|
| PDF | `.pdf` |
| Word | `.docx` |
| PowerPoint | `.pptx` |
| Excel | `.xlsx`, `.xls` |
| HTML | `.html`, `.htm`, or piped HTML content |
| Images | `.jpg`, `.png`, etc. (extracts EXIF metadata; OCR with plugin) |
| Audio | `.wav`, `.mp3` (extracts metadata; transcription with plugin) |
| Structured text | `.csv`, `.json`, `.xml` |
| EPub | `.epub` |
| YouTube | YouTube URLs (fetches transcript) |


Skip markitdown when:
- The file is already plain text, Markdown, or source code — just read it directly.
- Your agent tooling natively handles the format (e.g. built-in PDF or image reading). Native tooling preserves visual layout and embedded content better than a text conversion. Prefer it when available; fall back to markitdown for formats your tools can't open.

## Decision Flow

```
Is the file plain text, Markdown, or source code?
  YES → Read directly, skip markitdown
  NO  → Can your agent tools natively read this format (e.g. PDF, images)?
         YES → Use native tooling (better fidelity for layout & embedded content)
         NO  → Run: markitdown <file>
                ├─ Success → Use the Markdown output as context
                └─ Failure (command not found / permission error)
                     → Do NOT install it yourself
                     → Tell the user to install it:
                        "With Python and pipx available, run:
                         pipx install 'markitdown[all]'"
                        See https://github.com/microsoft/markitdown
                     → Explain why you need it and what file you were trying to convert
```

## NEVER

- **NEVER install markitdown yourself** — Python environments vary (system, venv, version managers). Always provide the install command and let the user handle it: `pipx install "markitdown[all]"` (see https://github.com/microsoft/markitdown)
- **NEVER try to read binary files (PDF, DOCX, PPTX, XLSX) directly** with file-read tools — you'll get garbage. Convert first.
- **NEVER run markitdown on files that are already text/Markdown/code** — it's pointless overhead.
- **NEVER assume markitdown is installed** — check by running it; handle failure gracefully per the decision flow above.
- **NEVER run markitdown on ZIP files** — it iterates and unpacks archive contents, which is unpredictable and potentially unsafe. If the user needs content from a ZIP, let them extract it manually first.
