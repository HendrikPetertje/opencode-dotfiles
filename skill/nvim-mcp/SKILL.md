---
name: nvim-mcp
description: >
  Control and edit a live Neovim instance via nvim-mcp tools. Use when the
  user wants to view, edit, or navigate files in an open Neovim session, or
  when asked to "open in neovim", "edit in neovim", "show in neovim", or
  "highlight" code in the editor. Provides critical rules for buffer vs disk
  priority, terminal window handling, highlight colors, and multi-instance
  disambiguation. MUST be loaded before making any nvim-mcp tool calls.
  MANDATORY: if nvim-mcp tools are available in the current tool list, this
  skill MUST be loaded before using them, without waiting for the user to ask.
---

# Neovim via nvim-mcp

## MCP Availability Check

**Check this first before reading anything else in this skill.**

Verify that nvim-mcp tools (`get_state`, `connect`, `send_command`, etc.) are
present in your available tool list.

- **If nvim-mcp tools are NOT available:** Stop here. Inform the user:
  "The nvim-mcp skill was loaded but the nvim-mcp MCP server is not available.
  No Neovim integration is active." Disregard all remaining instructions in
  this skill.
- **If nvim-mcp tools ARE available:** Continue with the rules below.

---

The user edits code in Neovim. You control it through nvim-mcp tools.

## After Compaction

If context compaction or context flattening has just occurred, reload this
skill immediately before doing anything else — compaction wipes loaded skill
content from the active context. Call `skill({ name: "nvim-mcp" })` as the
first action after compaction, then proceed with `get_state` as you would on
every turn.

## Critical Rules

**Call `get_state` at the START of every turn — before ANY nvim-mcp call,
file read, or disk edit that touches a Neovim buffer. Never carry over
cursor position or file identity from a previous turn.**

1. **Buffer tools take priority over disk.** If a file appears in `buffers`,
   use buffer tools exclusively — not disk reads/writes.
   - Read: `read_full_buf` or `read_buf_range` for a slice
   - Edit: `find_and_replace_buf` or `write_full_buf` for full content
   - This ensures the user sees changes immediately and gets undo history.
   - Fall back to disk only if the file is not in `buffers`.

2. **Active window = user's context.** If the active window is a terminal,
   the user's file context is the alternate window. When opening files in
   that case, use `send_command(["wincmd p", "e <file>", "wincmd p"])`.
   If the terminal is the only window, use `send_command("vsplit <file>")`.

3. **Preserve terminal window position when splitting.** If a terminal window
   exists, switch to a non-terminal window first before opening splits, then
   switch back if needed. Never replace the terminal window.

## Highlight Colors (Rose Pine Main)

When using `highlight_range`, use these colors from the rose-pine main palette:

| Purpose | Color | Rose Pine token |
|---|---|---|
| Focus (default) | `#403d52` | `highlight_med` |
| Errors / problems | `#eb6f92` bg tint → `#3d1f2a` | love-tinted dark |
| Good / additions | `#31748f` bg tint → `#1a2e35` | pine-tinted dark |
| Info / context | `#9ccfd8` bg tint → `#1e2e30` | foam-tinted dark |
| Warnings / caution | `#f6c177` bg tint → `#2e2516` | gold-tinted dark |
| Suggestions / notes | `#c4a7e7` bg tint → `#26203a` | iris-tinted dark |

Practical hex values to use directly:

- Focus: `#403d52`
- Errors: `#3d1f2a`
- Good: `#1a2e35`
- Info: `#1e2e30`
- Warnings: `#2e2516`
- Suggestions: `#26203a`

## Multi-Instance

When multiple Neovim instances are running, `connect` will list them. Ask
the user which one to use — never guess.
