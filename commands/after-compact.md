---
description: Run after context compaction to restore active skills
---
Context compaction just occurred. Reload any skills that were active before compaction. If the nvim-mcp skill was in use, call skill({ name: "nvim-mcp" }) now, then call get_state before touching any Neovim buffers. Confirm which skills have been reloaded.
