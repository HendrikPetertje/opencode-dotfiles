---
description: Prepare caveman-style compression for next /compress
---

Load the `caveman` skill and acknowledge the following instruction:

When the next context compression occurs (via `/compress`), apply caveman compression rules to the summary: drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms. Preserve EXACTLY: code blocks, inline code, URLs, file paths, commands, technical terms, proper nouns, dates, version numbers, env vars.

This is a one-shot compression style override. After compression, continue the conversation in normal language. Do NOT activate caveman mode for ongoing responses.
