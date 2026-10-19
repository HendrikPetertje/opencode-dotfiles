import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const API = process.env.AGENTMEMORY_URL || "http://localhost:3111";
// OpenCode reports tool names in lowercase ("read", "edit", ...); matching is
// case-insensitive at the call site so a future casing change cannot silently
// kill file enrichment again.
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);
const FILE_KEYS = ["filePath", "file_path", "path", "file"];
const MAX_STASHED_FILES = 20;

const DEBUG = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1";
function usableSecret(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || (trimmed.startsWith("${") && trimmed.endsWith("}"))) return "";
  return trimmed;
}

function readAgentmemoryFile(name: string): string {
  try {
    return readFileSync(join(homedir(), ".agentmemory", name), "utf-8");
  } catch {
    return "";
  }
}

function envFileSecret(): string {
  let found = "";
  for (const line of readAgentmemoryFile(".env").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).replace(/^export\s+/, "").trim() !== "AGENTMEMORY_SECRET") continue;
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    if (close > 0) value = value.slice(1, close);
    else if (value.includes(" #")) value = value.slice(0, value.indexOf(" #"));
    found = usableSecret(value);
  }
  return found;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function resolveSecret(url: string, explicit: string | undefined): string {
  const configured = usableSecret(explicit);
  if (configured) return configured;
  if (!isLoopbackUrl(url)) return "";
  return envFileSecret() || usableSecret(readAgentmemoryFile("secret"));
}

const SECRET = resolveSecret(API, process.env.AGENTMEMORY_SECRET);

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  try {
    await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
    return null;
  }
}

async function observe(
  sessionId: string,
  hookType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const proj = projectFor(sessionId);
  await post("/observe", {
    hookType,
    sessionId,
    project: proj.name,
    cwd: proj.cwd,
    timestamp: new Date().toISOString(),
    data,
  });
}

let activeSessionId: string | null = null;
let pendingConfig: Record<string, unknown> | null = null;
// Default scope resolved at plugin init (same resolution order as the hooks'
// resolveProject: env override, git repository basename, cwd basename). In a
// long-lived OpenCode process serving multiple directories these defaults are
// only a fallback — attribution is per-session via sessionProjects, resolved
// from each session's own directory at session.created. Module-level-only
// state recorded home-directory sessions under whatever repo loaded first.
let defaultProjectName: string | null = null;
let defaultProjectCwd: string | null = null;
const sessionProjects = new Map<string, { name: string; cwd: string }>();

function projectFor(sessionId: string): { name: string | null; cwd: string | null } {
  const p = sessionProjects.get(sessionId);
  return p ?? { name: defaultProjectName, cwd: defaultProjectCwd };
}

const projectNameCache = new Map<string, string>();

function resolveProjectName(dir: string): string {
  const explicit = process.env.AGENTMEMORY_PROJECT_NAME?.trim();
  if (explicit) return explicit;
  const cached = projectNameCache.get(dir);
  if (cached !== undefined) return cached;
  try {
    const [top, gitDir, commonDir] = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
      {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      },
    )
      .trim()
      .split(/\r?\n/);
    if (top) {
      const name = basename(repositoryRoot(dir, top, gitDir, commonDir));
      projectNameCache.set(dir, name);
      return name;
    }
  } catch {
    // not a git repo, fall through
  }
  const fallback = basename(dir) || dir;
  projectNameCache.set(dir, fallback);
  return fallback;
}

function repositoryRoot(dir: string, top: string, gitDir?: string, commonDir?: string): string {
  if (!gitDir || !commonDir) return top;
  const physical = realpathSync(dir);
  const common = resolve(physical, commonDir);
  if (resolve(physical, gitDir) === common || basename(common) !== ".git") return top;
  return dirname(common);
}
const stashedFiles = new Map<string, Set<string>>();
const seenSubtaskIds = new Map<string, Set<string>>();
const seenToolCallIds = new Map<string, Set<string>>();
// cache the context returned by POST /session/start so the chat
// system-transform hook can inject it without a second /context fetch.
// Auto-injection now happens at session.created (immediately) AND at
// the first prompt_submit (fallback for older OpenCode builds that
// don't implement experimental.chat.system.transform).
const startContextCache = new Map<string, string>();

function stashFor(sid: string): Set<string> {
  let s = stashedFiles.get(sid);
  if (!s) { s = new Set<string>(); stashedFiles.set(sid, s); }
  return s;
}

function subtaskSetFor(sid: string): Set<string> {
  let s = seenSubtaskIds.get(sid);
  if (!s) { s = new Set<string>(); seenSubtaskIds.set(sid, s); }
  return s;
}

function toolCallSetFor(sid: string): Set<string> {
  let s = seenToolCallIds.get(sid);
  if (!s) { s = new Set<string>(); seenToolCallIds.set(sid, s); }
  return s;
}

function pruneSessionMaps(sid: string): void {
  stashedFiles.delete(sid);
  seenSubtaskIds.delete(sid);
  seenToolCallIds.delete(sid);
  sessionProjects.delete(sid);
}

function safeSlice(v: unknown, max: number): string {
  if (typeof v === "string") return v.slice(0, max);
  if (v == null) return "";
  try { return JSON.stringify(v).slice(0, max); } catch { return ""; }
}

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

memory_lesson_save — Save a lesson learned (what worked, what to avoid).
  Use when: you discover a pattern that could help future sessions avoid mistakes.

memory_lesson_recall — Search lessons by query. Returns lessons sorted by confidence.
  Use when: before making a decision, check if past lessons apply.

All memory tools start with \`agentmemory_memory_\`. Use the exact names as they appear in your tool list. Tool results are JSON. Always check what was returned before presenting to the user.
</agentmemory-instructions>`;

function extractFilePaths(args: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of FILE_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      files.push(val);
    }
  }
  return files;
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
    }
    if (typeof e.name === "string") return e.name;
    try { return JSON.stringify(err); } catch { return ""; }
  }
  return String(err ?? "");
}

async function v2Setup(ctx: any) {
  if (typeof ctx?.tool?.hook !== "function" || typeof ctx?.session?.hook !== "function" || typeof ctx?.event?.subscribe !== "function") {
    return;
  }
  const location = ctx.location;
  defaultProjectCwd = location?.directory ?? location?.project?.directory ?? process.cwd();
  defaultProjectName = resolveProjectName(defaultProjectCwd);

  async function observeV2(sessionId: string, hookType: string, data: Record<string, unknown>): Promise<void> {
    await observe(sessionId, hookType, data);
  }

  const shellSessions = new Map<string, string>();
  const turnContextCache = new Map<string, string>();
  const baselines = new Map<string, { anchorId: string | undefined; text: string }>();
  const enrichByMessage = new Map<string, Map<string, string>>();
  const enrichAttempted = new Map<string, Set<string>>();

  function stashAdd(sid: string, paths: Iterable<string>): void {
    const stash = stashFor(sid);
    for (const p of paths) stash.add(p);
    if (stash.size > MAX_STASHED_FILES) {
      const keep = [...stash].slice(-MAX_STASHED_FILES);
      stash.clear();
      for (const k of keep) stash.add(k);
    }
  }

  const toolNames = new Map<string, string>();
  const toolCallInputs = new Map<string, Record<string, unknown>>();
  const reportedToolCalls = new Set<string>();
  const registeredSessions = new Set<string>();

  function namesFrom(result: unknown): string[] {
    const arr = Array.isArray(result) ? result : (result as any)?.data;
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => (typeof x === "string" ? x : x?.id ?? x?.name)).filter(Boolean);
  }

  let lastConfigSnapshot: string | null = null;

  async function snapshotConfig(): Promise<void> {
    const [agents, providers, mcp, modelDefault] = await Promise.all([
      ctx.agent?.list?.().catch(() => null),
      ctx.provider?.list?.().catch(() => null),
      ctx.mcp?.list?.().catch(() => null),
      Promise.resolve(ctx.model?.default?.()).catch(() => null),
    ]);
    const model = Array.isArray(modelDefault) ? modelDefault[0] : (modelDefault as any)?.data;
    const payload = {
      agents: namesFrom(agents),
      providers: namesFrom(providers),
      mcp_servers: namesFrom(mcp),
      model: model ? `${model.providerID ?? ""}/${model.id ?? model.modelID ?? ""}` : null,
      model_limits: model?.limit ?? null,
      location: defaultProjectCwd,
    };
    const snapshot = JSON.stringify(payload);
    if (snapshot === lastConfigSnapshot) return;
    lastConfigSnapshot = snapshot;
    if (activeSessionId) await observeV2(activeSessionId, "config_loaded", payload);
    else pendingConfig = payload;
  }

  void snapshotConfig().catch((e) => {
    if (DEBUG) console.error("[agentmemory] config snapshot failed:", (e as Error).message);
  });

  await ctx.tool.hook("execute.before", (event: any) => {
    if (!FILE_TOOLS.has(String(event?.tool ?? "").toLowerCase())) return;
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    const args = event?.input as Record<string, unknown> | undefined;
    if (!args) return;
    stashAdd(sid, extractFilePaths(args));
  });

  await ctx.tool.hook("execute.after", async (event: any) => {
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    const tool = String(event?.tool ?? "");
    const callId = (event?.id as string) || (event?.messageID as string) || null;
    const status = String(event?.status ?? "");
    const result = event?.result ?? {};
    const metadata = (result?.metadata ?? {}) as Record<string, unknown>;
    const output = result?.output as Record<string, unknown> | undefined;
    const raw = output?.output ?? result?.content;
    const text = Array.isArray(raw)
      ? raw.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
      : typeof raw === "string"
        ? raw
        : "";
    const startMs = typeof metadata?.started === "number" ? metadata.started : null;
    const endMs = typeof metadata?.ended === "number" ? metadata.ended : null;
    const duration = startMs != null && endMs != null ? endMs - startMs : null;

    if (status === "error") {
      await observeV2(sid, "post_tool_failure", {
        tool_name: tool,
        call_id: callId,
        tool_input: safeSlice(event?.input, 4000),
        tool_output: safeSlice(text || extractErrorMessage(event?.error) || extractErrorMessage(metadata?.error), 8000),
        duration_ms: duration,
      });
      if (callId) reportedToolCalls.add(`${sid}:${callId}`);
      return;
    }

    await observeV2(sid, "post_tool_use", {
      tool_name: tool,
      call_id: callId,
      tool_input: safeSlice(event?.input, 4000),
      tool_output: safeSlice(text, 8000),
      title: (output?.title as string) ?? null,
      metadata: metadata,
      duration_ms: duration,
      attachments: Array.isArray(output?.attachments)
        ? (output?.attachments as Array<Record<string, unknown>>).map((a) => a.filename || a.url)
        : [],
    });
    if (callId) reportedToolCalls.add(`${sid}:${callId}`);
  });

  await ctx.session.hook("prompt", async (event: any) => {
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    const files = (event?.prompt?.files ?? [])
      .map((f: any) => (typeof f === "string" ? f : f?.uri ?? f?.filename ?? f?.url))
      .filter(Boolean) as string[];
    stashAdd(sid, files);
    turnContextCache.delete(sid);
    await observeV2(sid, "prompt_submit", {
      prompt: (event?.prompt?.text ?? "").slice(0, 8000),
      files: files.slice(0, 20),
      agents: event?.prompt?.agents ?? [],
      skills: event?.prompt?.skills ?? [],
      delivery: event?.delivery ?? null,
    });
  });

  // The context hook never touches `system`: v2 rebuilds messages from the DB on every
  // request, so edits are re-applied here deterministically (same bytes each request) to
  // keep the provider's cached prefix stable.
  await ctx.session.hook("context", async (event: any) => {
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const part = (text: string) => ({ type: "text", text });

    // Baseline: instructions + recalled context, frozen per anchor. The anchor is the first
    // message of the request; after compaction that is the checkpoint, so we re-anchor.
    const first = messages[0];
    let base = baselines.get(sid);
    if (!base || base.anchorId !== first?.id) {
      let ctxText = startContextCache.get(sid);
      startContextCache.delete(sid);
      if (typeof ctxText !== "string" || ctxText.length === 0) {
        const result = await postJson("/context", { sessionId: sid, project: projectFor(sid).name });
        ctxText = (result as any)?.context;
      }
      if (typeof ctxText === "string" && ctxText.length > 0) turnContextCache.set(sid, ctxText);
      base = {
        anchorId: first?.id,
        text: typeof ctxText === "string" && ctxText.length > 0
          ? `${AGENTMEMORY_INSTRUCTIONS}\n\n<agentmemory-context>\n${ctxText}\n</agentmemory-context>`
          : AGENTMEMORY_INSTRUCTIONS,
      };
      baselines.set(sid, base);
    }
    if (first?.role === "user" && Array.isArray(first.content)) {
      messages[0] = { ...first, content: [part(base.text), ...first.content] };
    } else if (Array.isArray(event.system)) {
      event.system.push(part(base.text));
    }

    // File enrichment: fetched at most once per user message, then re-applied verbatim.
    let enrich = enrichByMessage.get(sid);
    if (!enrich) enrich = new Map(), enrichByMessage.set(sid, enrich);
    let attempted = enrichAttempted.get(sid);
    if (!attempted) attempted = new Set(), enrichAttempted.set(sid, attempted);
    const lastUser = messages.findLastIndex((m: any) => m?.role === "user");
    const lastId = lastUser >= 0 ? messages[lastUser]?.id : undefined;
    if (lastId && !attempted.has(lastId)) {
      attempted.add(lastId);
      const stash = stashFor(sid);
      if (stash.size > 0) {
        const files = [...stash].slice(0, 10);
        const res = await postJson("/enrich", { sessionId: sid, files, toolName: "enrich_inject" });
        const text = (res as any)?.context;
        if (typeof text === "string" && text.length > 0) {
          enrich.set(lastId, `<agentmemory-file-context>\n${text}\n</agentmemory-file-context>`);
          for (const f of files) stash.delete(f);
        }
      }
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const text = m?.id ? enrich.get(m.id) : undefined;
      if (text && Array.isArray(m.content)) messages[i] = { ...m, content: [...m.content, part(text)] };
    }
  });

  await ctx.session.hook("compaction", async (event: any) => {
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    if (!Array.isArray(event?.system)) return;
    let ctxText = turnContextCache.get(sid);
    if (typeof ctxText !== "string" || ctxText.length === 0) {
      const result = await postJson("/context", { sessionId: sid, project: projectFor(sid).name });
      ctxText = (result as any)?.context;
      if (typeof ctxText === "string" && ctxText.length > 0) turnContextCache.set(sid, ctxText);
    }
    if (typeof ctxText === "string" && ctxText.length > 0) {
      event.system.push({ type: "text", text: ctxText });
    }
  });

  const controller = new AbortController();

  const handleEvent = async (event: any): Promise<void> => {
    const type = String(event?.type ?? "");
    const data: any = event?.data ?? {};
    const eventSid = typeof data.sessionID === "string" && data.sessionID ? data.sessionID : null;
    const sid0 = eventSid || activeSessionId;

    if (eventSid && !registeredSessions.has(eventSid)) {
      if (!activeSessionId) activeSessionId = eventSid;
      stashedFiles.set(sid0, new Set());
      seenSubtaskIds.delete(sid0);
      seenToolCallIds.delete(sid0);
      baselines.delete(sid0);
      const dir = (data.location?.directory as string) || (event?.location?.directory as string) || null;
      if (dir) {
        sessionProjects.set(sid0, { cwd: dir, name: resolveProjectName(dir) });
      }
      const proj = projectFor(sid0);
      const startResult = await postJson("/session/start", {
        sessionId: sid0,
        title: (data.title as string) ?? null,
        parentID: (data.parentID as string) ?? null,
        project: proj.name,
        cwd: proj.cwd,
      });

      if (startResult === null) {
        stashedFiles.delete(sid0);
        baselines.delete(sid0);
        if (activeSessionId === eventSid) activeSessionId = null;
        if (DEBUG) {
          console.error("[agentmemory] /session/start failed, will retry on the next event for", eventSid);
        }
        return;
      }
      registeredSessions.add(eventSid);

      const startCtx = (startResult as any)?.context;
      if (typeof startCtx === "string" && startCtx.length > 0) startContextCache.set(sid0, startCtx);
      await observeV2(sid0, "session_started", {});
      if (pendingConfig) {
        await observeV2(sid0, "config_loaded", pendingConfig);
        pendingConfig = null;
      }
    }

    switch (type) {

      case "session.execution.failed": {
        if (!sid0) return;
        await observeV2(sid0, "post_tool_failure", {
          tool_name: "session.execution",
          tool_input: "",
          tool_output: safeSlice(extractErrorMessage(data.error ?? data), 8000),
        });
        return;
      }

      case "session.compaction.started": {
        if (!sid0) return;
        await observeV2(sid0, "compaction_event", {
          state: "started",
          reason: (data.reason as string) ?? null,
          inputID: (data.inputID as string) ?? null,
          recent: safeSlice(data.recent, 8000),
        });
        return;
      }

      case "session.compaction.failed": {
        if (!sid0) return;
        await observeV2(sid0, "compaction_event", {
          state: "failed",
          reason: (data.reason as string) ?? null,
          inputID: (data.inputID as string) ?? null,
          tool_output: safeSlice(extractErrorMessage(data.error ?? data.reason), 8000),
        });
        return;
      }

      case "session.step.started": {
        if (!sid0) return;
        await observeV2(sid0, "step_start", {
          messageID: (data.assistantMessageID as string) ?? null,
          agent: (data.agent as string) ?? null,
          model: data.model ? `${data.model.providerID ?? ""}/${data.model.id ?? ""}` : null,
        });
        return;
      }

      case "session.step.ended": {
        if (!sid0) return;
        const tokens = (data.tokens ?? {}) as Record<string, any>;
        await observeV2(sid0, "step_finish", {
          messageID: (data.assistantMessageID as string) ?? null,
          reason: (data.rawFinish as string) ?? (data.finish as string) ?? null,
          cost: data.cost ?? 0,
          input_tokens: tokens.input ?? 0,
          output_tokens: tokens.output ?? 0,
          reasoning_tokens: tokens.reasoning ?? 0,
          cache_read: tokens.cache?.read ?? 0,
          cache_write: tokens.cache?.write ?? 0,
        });
        return;
      }

      case "session.agent.selected": {
        if (!sid0) return;
        await observeV2(sid0, "agent_selected", {
          name: (data.agent as string) ?? null,
          previous: (data.previous as string) ?? null,
        });
        return;
      }

      case "session.reasoning.ended": {
        if (!sid0) return;
        await observeV2(sid0, "reasoning", {
          messageID: (data.assistantMessageID as string) ?? null,
          text: safeSlice(data.text, 4000),
        });
        return;
      }

      case "session.instructions.updated": {
        if (!sid0) return;
        const sources = data.delta && typeof data.delta === "object" ? Object.keys(data.delta) : [];
        if (sources.length === 0) return;
        await observeV2(sid0, "notification", {
          notification_type: "instructions_updated",
          sources: sources.slice(0, 50),
        });
        return;
      }

      case "session.text.ended": {
        if (!sid0) return;
        const text = typeof data.text === "string" ? data.text : "";
        if (!text) return;
        await observeV2(sid0, "assistant_message", {
          messageID: (data.assistantMessageID as string) ?? null,
          text: text.slice(0, 8000),
        });
        return;
      }

      case "session.execution.succeeded": {
        if (!sid0) return;
        await post("/summarize", { sessionId: sid0 });
        return;
      }

      case "shell.created": {
        const info = (data.info ?? {}) as Record<string, any>;
        const shellSid = (info.metadata?.sessionID as string) || sid0;
        if (!shellSid) return;
        if (info.id) shellSessions.set(String(info.id), shellSid);
        return;
      }

      case "shell.exited": {
        const shellId = String(data.id ?? "");
        const shellSid = shellSessions.get(shellId) || activeSessionId;
        if (!shellSid) return;
        const exit = Number(data.exit ?? 0);
        if (exit !== 0) {
          await observeV2(shellSid, "post_tool_failure", {
            tool_name: "shell",
            call_id: shellId,
            tool_input: null,
            tool_output: safeSlice(data.status, 4000),
            duration_ms: null,
          });
        }
        return;
      }

      case "shell.deleted": {
        const shellId = String(data.id ?? "");
        shellSessions.delete(shellId);
        return;
      }

      case "file.watcher.updated":
      case "filesystem.changed":
      case "vcs.branch.updated": {
        const sid = sid0 || activeSessionId;
        if (!sid) return;
        const file = (data.file as string) ?? (data.path as string) ?? null;
        if (file) stashAdd(sid, [file]);
        return;
      }

      case "session.tool.input.started": {
        if (!sid0) return;
        if (data.id) toolNames.set(String(data.id), String(data.name ?? ""));
        return;
      }

      case "session.tool.input.ended": {
        if (!sid0) return;
        if (data.id && typeof data.text === "string" && !toolNames.has(String(data.id))) {
          try {
            const parsed = JSON.parse(data.text);
            if (typeof parsed?.name === "string") toolNames.set(String(data.id), parsed.name);
          } catch {
          }
        }
        return;
      }

      case "session.tool.called": {
        if (!sid0) return;
        if (data.id) toolCallInputs.set(String(data.id), (data.input ?? {}) as Record<string, unknown>);
        return;
      }

      case "session.tool.progress": {
        if (!sid0) return;
        const callId = String(data.id ?? "");
        if (!callId || !FILE_TOOLS.has((toolNames.get(callId) ?? "").toLowerCase())) return;
        const input = toolCallInputs.get(callId);
        if (!input) return;
        stashAdd(sid0, extractFilePaths(input));
        return;
      }

      case "session.tool.success": {
        const callId = String(data.id ?? "");
        toolNames.delete(callId);
        toolCallInputs.delete(callId);
        if (sid0) reportedToolCalls.delete(`${sid0}:${callId}`);
        return;
      }

      case "session.tool.failed": {
        if (!sid0) return;
        const callId = String(data.id ?? "");
        if (callId && reportedToolCalls.has(`${sid0}:${callId}`)) return;
        await observeV2(sid0, "post_tool_failure", {
          tool_name: toolNames.get(callId) || null,
          call_id: callId || null,
          tool_input: safeSlice(toolCallInputs.get(callId), 4000),
          tool_output: safeSlice(extractErrorMessage(data.error), 8000),
          duration_ms: null,
        });
        if (callId) {
          toolNames.delete(callId);
          toolCallInputs.delete(callId);
        }
        return;
      }

      case "permission.asked": {
        if (!sid0) return;
        const resources = (data.resources ?? data.patterns ?? []) as unknown;
        await observeV2(sid0, "notification", {
          notification_type: "permission_prompt",
          permission: (data.action as string) ?? (data.permission as string) ?? "unknown",
          pattern: Array.isArray(resources) ? resources.join(", ") : String(resources ?? ""),
          tool_call_id: (data.tool?.callID as string) ?? (data.callID as string) ?? null,
          title: (data.action as string) ?? (data.permission as string) ?? "",
          metadata: data.metadata ?? {},
        });
        return;
      }

      case "permission.replied": {
        if (!sid0) return;
        await observeV2(sid0, "permission_replied", {
          permission_id: (data.requestID as string) ?? (data.permissionID as string) ?? "",
          response: (data.reply as string) ?? (data.response as string) ?? "",
        });
        return;
      }

      case "session.deleted": {
        const sid = (data.sessionID as string) || activeSessionId;
        if (!sid) return;
        await post("/session/end", { sessionId: sid, final: true });
        void post("/crystals/auto", { olderThanDays: 7 }, 30000);
        void post("/consolidate-pipeline", { tier: "all", force: true }, 30000);
        if (sid === activeSessionId) activeSessionId = null;
        registeredSessions.delete(sid);
        pruneSessionMaps(sid);
        startContextCache.delete(sid);
        baselines.delete(sid);
        enrichByMessage.delete(sid);
        enrichAttempted.delete(sid);
        for (const key of reportedToolCalls) {
          if (key.startsWith(`${sid}:`)) reportedToolCalls.delete(key);
        }
        return;
      }

      case "config.updated":
      case "agent.updated":
      case "provider.updated":
      case "model.updated":
      case "mcp.status.changed": {
        if (DEBUG) console.error("[agentmemory] config changed, re-snapshotting");
        void snapshotConfig().catch(() => {});
        return;
      }
    }
  };

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await handleEvent(event);
        } catch (e) {
          if (DEBUG) console.error("[agentmemory] event handler failed:", (e as Error).message);
        }
      }
    } catch (e) {
      if (DEBUG) console.error("[agentmemory] event stream failed:", (e as Error).message);
    }
  })();

  return () => {
    controller.abort();
    startContextCache.clear();
    baselines.clear();
    enrichByMessage.clear();
    enrichAttempted.clear();
  };
}

export default {
  id: "agentmemory-capture",
  setup: v2Setup,
};
