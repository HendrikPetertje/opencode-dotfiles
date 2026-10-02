import { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent } from "@opencode/client";
import { setTimeout as delay } from "node:timers/promises";

const API = process.env.AGENTMEMORY_URL || "http://localhost:3111";
const DEBUG = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const SECRET = process.env.AGENTMEMORY_SECRET || "";
const FILE_TOOLS = new Set(["read", "write", "edit", "patch", "glob", "grep"]);
const FILE_KEYS = ["filePath", "file_path", "path", "file", "pattern"];
const MAX_STASHED_FILES = 20;
const MAX_PENDING_EVENTS = 500;

const AGENTMEMORY_INSTRUCTIONS = `<agentmemory-instructions>
You have access to agentmemory for persistent cross-session memory. Use these tools proactively.

CORE TOOLS:

memory_save — Save an insight, decision, or fact to long-term memory.
  Required: content (text), concepts (2-5 comma-separated keywords), type (pattern/preference/architecture/bug/workflow/fact)
  Optional: files (comma-separated paths)
  Use when: user says "remember this", after discovering a bug, after making an architectural decision, after learning a project convention.

memory_recall — Search past observations by keywords.
  Use when: user says "recall", "what did we do", "do you remember", or needs context from past sessions.

memory_smart_search — Hybrid semantic+keyword search with progressive disclosure.
  Use when: you need the most relevant past context, fuzzy/conceptual searches, or recall doesn't find what you need.

memory_sessions — List recent sessions with status and observation counts.
  Use when: user asks about session/past history, "what did we work on".

memory_file_history — Get past observations about specific files (across all sessions).
  Use when: you're about to edit a file and want to know its history, common pitfalls, or past edits.

memory_lesson_save — Save a lesson learned (what worked, what to avoid).
  Use when: you discover a pattern that could help future sessions avoid mistakes.

memory_lesson_recall — Search lessons by query. Returns lessons sorted by confidence.
  Use when: before making a decision, check if past lessons apply.

memory_governance_delete — Delete specific memories. Requires explicit user confirmation.
  Use when: user says "forget this", "delete that memory".

memory_patterns — Detect recurring patterns across sessions.
  Use when: you want to understand project-level trends over time.

memory_consolidate — Run the 4-tier memory consolidation pipeline.
  Use when: you want to compress and organize accumulated session observations.

Use the exact memory tool names from your tool list or Code Mode catalog. Tool results are JSON. Always check what was returned before presenting to the user.
</agentmemory-instructions>`;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function safeSlice(value: unknown, max: number): string {
  if (typeof value === "string") return value.slice(0, max);
  if (value == null) return "";
  try { return (JSON.stringify(value) ?? "").slice(0, max); } catch { return ""; }
}

function contextText(value: unknown): string {
  const context = record(value).context;
  return typeof context === "string" ? context : "";
}

interface SessionState {
  directory: string;
  files: Set<string>;
  context: string;
  tools: Map<string, { name: string; input?: unknown; started: number }>;
  steps: Map<string, { started: number; agent: string; model: { providerID: string; id: string } }>;
}

export default Plugin.define({
  id: "agentmemory.capture",
  async setup(ctx) {
    const controller = new AbortController();
    const sessions = new Map<string, SessionState>();
    const starting = new Map<string, Promise<SessionState | undefined>>();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (SECRET) headers.Authorization = `Bearer ${SECRET}`;

    // Memory capture is optional: failures must never abort the user's request.
    async function safeCapture(work: () => Promise<void>): Promise<void> {
      try { await work(); } catch (error) {
        if (DEBUG) console.error("[agentmemory] capture failed:", (error as Error).message);
      }
    }

    async function post(endpoint: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
      if (controller.signal.aborted) return null;
      try {
        const response = await fetch(`${API}/agentmemory${endpoint}`, {
          method: "POST", headers, body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      } catch (error) {
        if (DEBUG && !controller.signal.aborted) {
          console.error(`[agentmemory] POST ${endpoint} failed:`, (error as Error).message);
        }
        return null;
      }
    }

    function owns(location: { directory: string; workspaceID?: string }): boolean {
      return location.directory === ctx.location.directory && location.workspaceID === ctx.location.workspaceID;
    }

    async function observe(sid: string, hookType: string, data: Record<string, unknown>): Promise<void> {
      const state = sessions.get(sid);
      if (!state) return;
      await post("/observe", {
        hookType, sessionId: sid, project: state.directory, cwd: state.directory,
        timestamp: new Date().toISOString(), data,
      });
    }

    async function ensureSession(sid: string): Promise<SessionState | undefined> {
      const existing = sessions.get(sid);
      if (existing) return existing;
      const pending = starting.get(sid);
      if (pending) return pending;
      const promise = (async () => {
        const session = await ctx.session.get({ sessionID: sid });
        if (!owns(session.location)) return;
        const state: SessionState = {
          directory: session.location.directory, files: new Set(), context: "",
          tools: new Map(), steps: new Map(),
        };
        sessions.set(sid, state);
        state.context = contextText(await post("/session/start", {
          sessionId: sid, title: session.title ?? null, parentID: session.parentID ?? null,
          version: ctx.app.version, project: state.directory, cwd: state.directory,
        }));
        // V2 has no mutable global config hook. Capture safe catalog metadata,
        // never provider settings, MCP environment values or credential headers.
        const [agents, providers, mcps, model] = await Promise.all([
          ctx.agent.list(), ctx.provider.list(), ctx.mcp.list(), ctx.model.default(),
        ]);
        await observe(sid, "config_loaded", {
          version: ctx.app.version, model: model.data ? { providerID: model.data.providerID, id: model.data.id } : null,
          agents: agents.data.map((agent) => agent.id),
          providers: providers.data.map((provider) => provider.id),
          mcp_servers: mcps.data.map((server) => server.name),
          permission: session.permissions ?? null,
        });
        return state;
      })().catch((error) => {
        if (DEBUG) console.error("[agentmemory] session lookup failed:", (error as Error).message);
        return sessions.get(sid);
      }).finally(() => starting.delete(sid));
      starting.set(sid, promise);
      return promise;
    }

    function stash(state: SessionState, files: Iterable<string>) {
      for (const file of files) {
        state.files.delete(file);
        state.files.add(file);
      }
      while (state.files.size > MAX_STASHED_FILES) {
        state.files.delete(state.files.values().next().value!);
      }
    }

    async function handleEvent(event: OpenCodeEvent): Promise<void> {
      if (event.location && !owns(event.location)) return;
      // V2 envelopes carry data, not V1 properties/info/parts.
      const data = record(event.data);
      const sid = data.sessionID;
      if (typeof sid !== "string") return;
      if (event.type === "session.deleted") {
        if (!sessions.has(sid)) return;
        await post("/session/end", { sessionId: sid });
        sessions.delete(sid);
        await post("/crystals/auto", { olderThanDays: 7 }, 30000);
        await post("/consolidate-pipeline", { tier: "all", force: true }, 30000);
        return;
      }
      const state = await ensureSession(sid);
      if (!state) return;

      switch (event.type) {
        case "session.created": {
          if (typeof data.parentID === "string" && await ensureSession(data.parentID)) {
            await observe(data.parentID, "subagent_start", {
              subtask_id: sid, agent: data.agent ?? null, description: data.title ?? null,
            });
          }
          break;
        }
        case "session.inbox.enqueued": {
          const item = record(data.item);
          if (item.type !== "user") break;
          const payload = record(item.payload);
          const files = Array.isArray(payload.files)
            ? payload.files.map((file) => record(file).uri).filter((uri): uri is string => typeof uri === "string") : [];
          stash(state, files);
          await observe(sid, "prompt_submit", {
            messageID: data.inboxID, prompt: safeSlice(payload.text, 8000), files: files.slice(0, 20),
            agents: payload.agents ?? [], skills: payload.skills ?? [], delivery: item.delivery,
          });
          break;
        }
        case "session.status": {
          const status = record(data.status);
          if (status.type === "idle") await post("/summarize", { sessionId: sid });
          await observe(sid, "session_status", {
            status_type: status.type, attempt: status.attempt ?? null, message: safeSlice(status.message, 2000),
          });
          break;
        }
        case "session.renamed":
        case "session.metadata.updated":
          await observe(sid, "session_updated", data);
          break;
        case "session.moved":
          // Let the destination location's instance take ownership and reload context.
          sessions.delete(sid);
          break;
        case "session.agent.selected":
          await observe(sid, "agent_selected", { name: data.agent });
          break;
        case "session.model.selected":
          await observe(sid, "model_selected", { model: data.model });
          break;
        case "session.step.started": {
          const model = record(data.model);
          state.steps.set(String(data.assistantMessageID), {
            started: event.created, agent: String(data.agent),
            model: { providerID: String(model.providerID), id: String(model.id) },
          });
          break;
        }
        case "session.step.ended":
        case "session.step.failed": {
          const messageID = String(data.assistantMessageID);
          const step = state.steps.get(messageID);
          state.steps.delete(messageID);
          const tokens = record(data.tokens);
          const cache = record(tokens.cache);
          await observe(sid, "assistant_message", {
            messageID, modelID: step?.model.id, providerID: step?.model.providerID, mode: step?.agent,
            cost: data.cost ?? 0, tokens: {
              input: tokens.input ?? 0, output: tokens.output ?? 0, reasoning: tokens.reasoning ?? 0,
              cache_read: cache.read ?? 0, cache_write: cache.write ?? 0,
            },
            finish: data.finish ?? null, error: data.error ?? null,
            duration_ms: step ? event.created - step.started : null,
          });
          await observe(sid, "step_finish", {
            messageID, reason: data.finish ?? null, cost: data.cost ?? 0,
            input_tokens: tokens.input ?? 0, output_tokens: tokens.output ?? 0, reasoning_tokens: tokens.reasoning ?? 0,
          });
          if (Array.isArray(data.files) && data.files.length) {
            stash(state, data.files.filter((file): file is string => typeof file === "string"));
            await observe(sid, "patch_applied", { messageID, hash: data.snapshot, files: data.files });
          }
          break;
        }
        case "session.tool.input.started":
          state.tools.set(String(data.id), { name: String(data.name), started: event.created });
          break;
        case "session.tool.called": {
          const tool = state.tools.get(String(data.id));
          if (tool) tool.input = data.input;
          break;
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const tool = state.tools.get(String(data.id));
          state.tools.delete(String(data.id));
          await observe(sid, event.type === "session.tool.success" ? "post_tool_use" : "post_tool_failure", {
            tool_name: tool?.name ?? "unknown", call_id: data.id,
            tool_input: safeSlice(tool?.input, 4000), tool_output: safeSlice(data.content ?? data.error, 8000),
            metadata: data.metadata ?? {}, duration_ms: tool ? event.created - tool.started : null,
          });
          break;
        }
        case "session.reasoning.ended":
          await observe(sid, "reasoning", { messageID: data.assistantMessageID, text: safeSlice(data.text, 4000) });
          break;
        case "session.compaction.started":
          await observe(sid, "compaction_event", { auto: data.reason === "auto" });
          break;
        case "session.compaction.ended":
          await post("/summarize", { sessionId: sid });
          await observe(sid, "session_compacted", { reason: data.reason });
          break;
        case "session.execution.failed":
          await observe(sid, "post_tool_failure", {
            tool_name: "session.execution.failed", tool_input: "", tool_output: safeSlice(data.error, 8000),
          });
          break;
        case "session.retry.scheduled":
          await observe(sid, "retry_attempt", { attempt: data.attempt, error: safeSlice(data.error, 2000) });
          break;
        case "permission.asked":
          await observe(sid, "notification", {
            notification_type: "permission_prompt", permission: data.action,
            pattern: data.resources, tool_call_id: record(data.source).id ?? null, metadata: data.metadata ?? {},
          });
          break;
        case "permission.replied":
          await observe(sid, "permission_replied", { permission_id: data.requestID, response: data.reply });
          break;
        case "session.revert.committed":
          await observe(sid, "message_removed", { messageID: data.to });
          break;
        case "session.shell.ended":
          await observe(sid, "command_executed", { shell: data.shell, output: safeSlice(data.output, 8000) });
          break;
      }
    }

    await ctx.tool.hook("execute.before", (event) => safeCapture(async () => {
      if (!FILE_TOOLS.has(event.tool.toLowerCase())) return;
      const state = await ensureSession(event.sessionID);
      if (!state) return;
      const input = record(event.input);
      stash(state, FILE_KEYS.map((key) => input[key]).filter((file): file is string => typeof file === "string" && !!file));
      // V2 patch carries paths inside patchText rather than a path argument.
      if (typeof input.patchText === "string") {
        stash(state, [...input.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
          .map((match) => match[1]));
      }
    }));

    await ctx.session.hook("context", (event) => safeCapture(async () => {
      const state = await ensureSession(event.sessionID);
      if (!state) return;
      event.system.push({ type: "text", text: AGENTMEMORY_INSTRUCTIONS });
      if (!state.context) {
        state.context = contextText(await post("/context", { sessionId: event.sessionID, project: state.directory }));
      }
      // V2 context hooks only change this outgoing request. Inject the cached
      // context on every call, not once into an assumed persistent system array.
      if (state.context) event.system.push({ type: "text", text: state.context });
      const files = [...state.files].slice(0, 10);
      if (files.length) {
        const enriched = contextText(await post("/enrich", {
          sessionId: event.sessionID, files, toolName: "enrich_inject",
        }));
        if (enriched) {
          event.system.push({ type: "text", text: enriched });
          for (const file of files) state.files.delete(file);
        }
      }
      const model = (await ctx.model.list()).data.find((candidate) =>
        candidate.providerID === event.model.providerID && candidate.id === event.model.id);
      await observe(event.sessionID, "llm_params", {
        agent: event.agent, model: `${event.model.providerID}/${event.model.id}`,
        variant: event.model.variant ?? null, temperature: event.options.temperature ?? model?.settings?.temperature,
        topP: event.options.topP ?? model?.settings?.topP,
        max_output_tokens: event.options.maxTokens ?? model?.limit.output, context_limit: model?.limit.context,
        cost_1k_input: (model?.cost[0]?.input ?? 0) / 1000, cost_1k_output: (model?.cost[0]?.output ?? 0) / 1000,
      });
    }));

    await ctx.session.hook("compaction", (event) => safeCapture(async () => {
      const state = await ensureSession(event.sessionID);
      if (!state) return;
      const context = contextText(await post("/context", { sessionId: event.sessionID, project: state.directory }));
      if (context) {
        state.context = context;
        event.system.push({ type: "text", text: context });
      }
    }));

    // Buffer slow HTTP capture work without holding up the shared event stream.
    let tail = Promise.resolve();
    let pending = 0;
    const listener = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type.endsWith(".delta") || (event.location && !owns(event.location))) continue;
            if (pending >= MAX_PENDING_EVENTS) {
              if (DEBUG) console.error("[agentmemory] event queue full; dropping", event.type);
              continue;
            }
            pending++;
            tail = tail.then(() => controller.signal.aborted ? undefined : handleEvent(event))
              .catch((error) => {
                if (DEBUG) console.error("[agentmemory] capture failed:", (error as Error).message);
              }).finally(() => { pending--; });
          }
        } catch (error) {
          if (DEBUG && !controller.signal.aborted) console.error("[agentmemory] event subscription failed:", (error as Error).message);
        }
        if (!controller.signal.aborted) {
          try { await delay(1000, undefined, { signal: controller.signal }); } catch { break; }
        }
      }
    })();

    return async () => {
      controller.abort();
      await listener;
      await tail;
      sessions.clear();
      starting.clear();
    };
  },
});
