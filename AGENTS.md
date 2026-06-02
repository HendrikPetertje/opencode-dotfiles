# Agentmemory: Proactive Memory Usage

You have access to agentmemory for persistent cross-session memory. Use it proactively without waiting for the user to ask.

## On session start

At the beginning of every session, before diving into the user's request:

1. Do not rely on a single vague `memory_smart_search` call. Start with two targeted lookups:
   - A user-wide recall for preferences and workflow rules using terms like `code style`, `tool preferences`, `build rules`, `testing patterns`, and keywords from the user's first message.
   - A project-context recall using the current session project's full absolute path plus stack, convention, architecture, bug, and file/module keywords that match the user's first message.
2. Use `memory_smart_search` only as a follow-up when you need broader discovery after the targeted recalls.
3. Apply useful recalled context silently by default. Only mention remembered context when the user asks, when it is necessary to resolve ambiguity, or when surfacing it prevents a likely mistake.
4. If the project is new or unfamiliar, ask the user about their preferences, conventions, and context -- then save those with `memory_save`.

## During work

- **Before editing a file**: check `memory_file_history` to see if there are known pitfalls or past decisions about that file.
- **Before making architectural decisions**: use `memory_lesson_recall` to check if past lessons apply.
- **After discovering something important**: save it with `memory_save` (bugs, patterns, preferences, architecture decisions).
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
- Bugs found and their root causes -- save as project-specific
- Architectural decisions and their rationale -- save as project-specific
- Patterns that worked well or failed -- save as project-specific
- File relationships and module boundaries -- save as project-specific

## What to proactively recall

Search memory when:

- The user mentions a topic you might have discussed before
- You're about to make a choice that could conflict with past decisions
- The user seems to be repeating context they've given before (save them the effort)
- Starting work on a file or module that may have history

## Asking the user

If memory is sparse for the current project, proactively ask:

- "Do you have any conventions or preferences I should know about for this project?"
- "Is there anything from past work on this codebase I should keep in mind?"

Then save their answers.
