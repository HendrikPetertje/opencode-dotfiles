/**
 * Auto mode: a reviewer model approves, denies or escalates permission
 * requests, in the spirit of Claude Code's auto mode. See README.md.
 */
import { Plugin } from "@opencode/plugin";
import { configuredRules, userDecides } from "./src/config-rules.ts";
import { collectDocuments } from "./src/documents.ts";
import { logDecision, logError } from "./src/log.ts";
import { parseModel, parseOptions } from "./src/options.ts";
import {
  addAllow,
  exactKey,
  DEFAULT_ALIKE_TOOLS,
  isAlikeTool,
  OVERRIDES,
  removeAllow,
  type AlikeEntry,
  type Override,
} from "./src/overrides.ts";
import type { CallRecord, RecordSource, RecordStatus } from "./src/records.ts";
import { addUsage, emptyCost, type CallUsage, type CostTotal } from "./src/cost.ts";
import { idleGuard, onDeny, onGuard, onReview, type Guard } from "./src/guard.ts";
import {
  alikePrompt,
  DENY_SUFFIX,
  parseAlike,
  parseDecision,
  parseTriage,
  policyFrom,
  questionPrompt,
  systemPrompt,
  type ReviewRequest,
} from "./src/reviewer.ts";
import { AutoMode } from "./src/rpc.ts";
import {
  adjust,
  globalDefaults,
  projectDefaults,
  effectiveSettings,
  SETTING_ROWS,
  visibleRows,
  type GlobalSettings,
  type ProjectSettings,
  type SettingKey,
} from "./src/settings.ts";
import { classify, EDIT_ACTIONS } from "./src/tiers.ts";
import { buildTranscript, findToolCall, findToolCommand, latestUserText } from "./src/transcript.ts";

const REVIEW_TIMEOUT_MS = 30_000;
const CONTEXT_TIMEOUT_MS = 3_000;
const REVIEW_ATTEMPTS = 2;
const MAX_CONSECUTIVE_DENIALS = 3;
const MAX_TOTAL_DENIALS = 20;
const MAX_RECORDS = 300;
/** Tools of the memory plugin's MCP server (`memory_aim_memory_read_all`, ...). */
const MEMORY_TOOL = /(^|_)aim_memory_/;
/** MCP servers can come and go; re-check the tool list at most this often. */
const MEMORY_CHECK_MS = 30_000;
const NO_MODEL = "no reviewer model: pick one in auto mode settings, or set \"model\" in the plugin options";

/** Drops modes that no longer exist (the old pattern-based "alike"). */
function validOverrides(stored: unknown): Record<string, Override> {
  const result: Record<string, Override> = {};
  if (stored && typeof stored === "object") {
    for (const [key, value] of Object.entries(stored)) {
      if (OVERRIDES.includes(value as Override)) result[key] = value as Override;
    }
  }
  return result;
}

/** Removes every `allow` marker on rows of this tool (whole-tool allows are marked on their origin row). */
function clearToolAllows(sess: SessionState, action: string): void {
  for (const [key, mode] of Object.entries(sess.overrides)) {
    if (mode === "allow" && key.startsWith(`${action}\u0000`)) delete sess.overrides[key];
  }
}

/** A row's mode as the modal shows it: a whole-tool allow shows on every row of that tool. */
function modeFor(sess: SessionState, alikeTools: readonly string[], action: string, subject: string): Override {
  const own = sess.overrides[exactKey(action, subject)];
  if (own) return own;
  return !isAlikeTool(action, alikeTools) && sess.always.includes(action) ? "allow" : "check";
}

interface SessionState {
  overrides: Record<string, Override>;
  /** "Allow" on an ordinary tool: every call to it, whatever the input. */
  always: string[];
  /** "Allow" on a `alikeTools` tool: the reviewer compares later calls with these. */
  alikes: AlikeEntry[];
}

interface ProjectState {
  settings: ProjectSettings;
}

interface SessionInfo {
  rootID: string;
  projectKey: string;
  directory?: string;
  /** Provider of the session's selected model, when it has one. */
  provider?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export default Plugin.define({
  id: "auto-mode",
  async setup(ctx) {
    const parsed = parseOptions(ctx.options as Record<string, unknown>);
    // A hot reload can pair this file with an older options.ts that predates `alikeTools`.
    const options = {
      ...parsed,
      alikeTools: Array.isArray(parsed.alikeTools) ? parsed.alikeTools : [...DEFAULT_ALIKE_TOOLS],
      memory: parsed.memory ?? ("auto" as const),
    };
    const policy = policyFrom(options.policy);
    /** The project's picked reviewer, else the `model` option. */
    const reviewerFor = (settings: ProjectSettings) => parseModel(settings.model) ?? options.model;
    if (options.problem) logError(options.problem);
    const c = ctx as any;

    // ---------------------------------------------------------------- storage

    const load = async <T>(key: string, fallback: T): Promise<T> => {
      try {
        const value = await ctx.storage.get(key);
        return value && typeof value === "object" ? ({ ...fallback, ...(value as object) } as T) : fallback;
      } catch (error) {
        logError(`storage get ${key}`, error);
        return fallback;
      }
    };
    const save = (key: string, value: unknown) =>
      ctx.storage.set(key, JSON.parse(JSON.stringify(value))).catch((error: unknown) => logError(`storage set ${key}`, error));

    // The server runs one copy of this plugin per location (home directory, each project) and a new
    // copy on every hot reload. Hooks run in the session's copy while the TUI's RPC can land in another,
    // so all mutable state lives in one object per process that every copy shares.
    const shared = ((globalThis as any).__opencodeAutoMode ??= {}) as {
      global?: GlobalSettings;
      projects?: Map<string, ProjectState>;
      sessions?: Map<string, SessionState>;
      approvedExact?: Map<string, Set<string>>;
      refused?: Map<string, Map<string, string | undefined>>;
      denials?: Map<string, { consecutive: number; total: number }>;
      records?: Map<string, CallRecord[]>;
      byID?: Map<string, CallRecord>;
      loading?: Map<string, Promise<void>>;
      costs?: Map<string, CostTotal>;
      guards?: Map<string, Guard>;
    };
    const global: GlobalSettings = (shared.global ??= await load("global", globalDefaults(options)));
    const projects = (shared.projects ??= new Map<string, ProjectState>());
    const sessions = (shared.sessions ??= new Map<string, SessionState>());

    const project = async (key: string): Promise<ProjectState> => {
      let state = projects.get(key);
      if (!state) {
        const stored = await load<Partial<ProjectState>>(`project:${key}`, {});
        state = { settings: { ...projectDefaults(options), ...(stored.settings ?? {}) } };
        projects.set(key, state);
      }
      return state;
    };
    const session = async (rootID: string): Promise<SessionState> => {
      let state = sessions.get(rootID);
      if (!state) {
        const stored = await load<Partial<SessionState>>(`session:${rootID}`, {});
        state = {
          overrides: validOverrides(stored.overrides),
          always: Array.isArray(stored.always) ? stored.always : [],
          alikes: Array.isArray(stored.alikes) ? stored.alikes : [],
        };
        sessions.set(rootID, state);
      }
      // Sessions loaded by an older copy of the plugin (hot reload) predate these fields and modes.
      state.always ??= [];
      state.alikes ??= [];
      state.overrides = validOverrides(state.overrides);
      return state;
    };

    // In-memory only: the reviewer's exact approvals, refusals and denial counts.
    const approvedExact = (shared.approvedExact ??= new Map<string, Set<string>>());
    const refused = (shared.refused ??= new Map<string, Map<string, string | undefined>>());
    const denials = (shared.denials ??= new Map<string, { consecutive: number; total: number }>());

    // ---------------------------------------------------------------- sessions

    const infoCache = new Map<string, SessionInfo>();
    const sessionInfo = async (sessionID: string): Promise<SessionInfo> => {
      const cached = infoCache.get(sessionID);
      if (cached) return cached;
      let info: SessionInfo = { rootID: sessionID, projectKey: `dir:${ctx.location?.directory ?? "unknown"}`, directory: ctx.location?.directory };
      try {
        const got = await withTimeout<any>(ctx.session.get({ sessionID } as any), CONTEXT_TIMEOUT_MS);
        const directory: string | undefined = got?.location?.directory ?? ctx.location?.directory;
        const projectKey = got?.projectID ? `id:${got.projectID}` : `dir:${directory}`;
        const rootID = got?.parentID ? (await sessionInfo(got.parentID)).rootID : sessionID;
        info = { rootID, projectKey, directory, provider: got?.model?.providerID };
        infoCache.set(sessionID, info);
      } catch (error) {
        logError(`session lookup ${sessionID}`, error);
      }
      return info;
    };

    const messagesFor = async (sessionID: string): Promise<unknown[]> => {
      try {
        const messages = await withTimeout<any>(ctx.session.context({ sessionID } as any), CONTEXT_TIMEOUT_MS);
        return Array.isArray(messages) ? messages : [];
      } catch (error) {
        logError(`session context ${sessionID}`, error);
        return [];
      }
    };

    // ---------------------------------------------------------------- records

    // Persisted per root session so the list survives plugin reloads (every
    // config save reloads plugins). Writes are debounced per session.
    const records = (shared.records ??= new Map<string, CallRecord[]>());
    const byID = (shared.byID ??= new Map<string, CallRecord>());
    let emit: (rootID: string) => void = () => {};
    let notify: (rootID: string) => void = () => {};

    const loading = (shared.loading ??= new Map<string, Promise<void>>());
    const costs = (shared.costs ??= new Map<string, CostTotal>());
    const guards = (shared.guards ??= new Map<string, Guard>());
    const snapshot = (rootID: string) => ({
      list: records.get(rootID) ?? [],
      cost: costs.get(rootID) ?? emptyCost(),
      guard: guards.get(rootID) ?? idleGuard(),
    });
    const ensureRecords = (rootID: string): Promise<void> => {
      if (!rootID || records.has(rootID)) return Promise.resolve();
      let pending = loading.get(rootID);
      if (!pending) {
        pending = (async () => {
          const stored = await load<{ list?: CallRecord[]; cost?: CostTotal; guard?: Guard }>(`records:${rootID}`, {});
          if (records.has(rootID)) return;
          const list = Array.isArray(stored.list) ? stored.list : [];
          for (const record of list) {
            // A reload interrupted these; they will never settle now.
            if (record.status === "running" || record.status === "reviewing") {
              record.status = "off";
              record.source = "off";
              record.reason = "interrupted by a plugin reload";
            }
            byID.set(record.id, record);
          }
          records.set(rootID, list);
          costs.set(rootID, { ...emptyCost(), ...(stored.cost ?? {}) });
          guards.set(rootID, { ...idleGuard(), ...(stored.guard ?? {}) });
        })().finally(() => loading.delete(rootID));
        loading.set(rootID, pending);
      }
      return pending;
    };

    const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const persist = (rootID: string) => {
      if (!records.has(rootID)) return;
      clearTimeout(saveTimers.get(rootID));
      saveTimers.set(
        rootID,
        setTimeout(() => {
          saveTimers.delete(rootID);
          void save(`records:${rootID}`, snapshot(rootID));
        }, 500),
      );
    };
    emit = (rootID: string) => {
      if (rootID !== "*") persist(rootID);
      notify(rootID);
    };

    const upsert = (record: CallRecord) => {
      if (!byID.has(record.id)) {
        const list = records.get(record.rootID) ?? [];
        list.push(record);
        if (list.length > MAX_RECORDS) for (const old of list.splice(0, list.length - MAX_RECORDS)) byID.delete(old.id);
        records.set(record.rootID, list);
        byID.set(record.id, record);
      }
      emit(record.rootID);
    };

    const settle = (record: CallRecord, status: RecordStatus, source: RecordSource, reason: string) => {
      record.status = status;
      record.source = source;
      record.reason = reason;
      record.at = Date.now();
      emit(record.rootID);
      if (options.log && status !== "off" && status !== "running" && status !== "reviewing") {
        logDecision({
          session: record.sessionID,
          action: record.action,
          subject: record.subject,
          decision: status,
          source,
          reason,
        });
      }
    };

    // ---------------------------------------------------------------- RPC

    // ---------------------------------------------------------------- memory plugin

    // The `.aim` memory belongs to a separate plugin (memory MCP). Without it, auto mode
    // neither reads memory nor shows its settings, so the plugin works on its own.
    let memoryCheck: { at: number; value: Promise<boolean> } | undefined;
    const memoryAvailable = (): Promise<boolean> => {
      if (options.memory !== "auto") return Promise.resolve(options.memory === true);
      if (memoryCheck && Date.now() - memoryCheck.at < MEMORY_CHECK_MS) return memoryCheck.value;
      const value = ctx.tool
        .list()
        .then((tools: readonly { id: string }[]) => tools.some((tool) => MEMORY_TOOL.test(tool.id)))
        .catch((error: unknown) => {
          logError("memory plugin check", error);
          return false;
        });
      memoryCheck = { at: Date.now(), value };
      return value;
    };

    const statePayload = async (input: { sessionID?: string; directory?: string }) => {
      const info = input.sessionID
        ? await sessionInfo(input.sessionID)
        : { rootID: "", projectKey: `dir:${input.directory ?? ctx.location?.directory}`, directory: input.directory };
      const proj = await project(info.projectKey);
      const sess = info.rootID ? await session(info.rootID) : undefined;
      await ensureRecords(info.rootID);
      const list = (records.get(info.rootID) ?? []).map((record) => ({
        ...record,
        override: sess ? modeFor(sess, options.alikeTools, record.action, record.subject) : "check",
        /** The user set allow on this exact call (the rule's origin), not just covered by it. */
        allowOrigin: sess?.overrides[exactKey(record.action, record.subject)] === "allow",
      }));
      return {
        enabled: global.enabled,
        yoloEdits: global.yoloEdits,
        settings: proj.settings,
        rows: visibleRows(SETTING_ROWS, await memoryAvailable()),
        problem: reviewerFor(proj.settings) ? null : NO_MODEL,
        model: (() => {
          const model = reviewerFor(proj.settings);
          return model ? `${model.providerID}/${model.id}` : null;
        })(),
        keybind: options.keybind,
        rootID: info.rootID,
        records: list,
        allowed: { tools: sess?.always ?? [], alikes: sess?.alikes ?? [] },
        alikeTools: options.alikeTools,
        cost: costs.get(info.rootID) ?? emptyCost(),
        guard: (guards.get(info.rootID) ?? idleGuard()).remaining,
      };
    };

    const registration = await ctx.rpc.register(AutoMode, {
      state: async (input: any) => statePayload(input ?? {}),
      setGlobal: async (input: any) => {
        if (typeof input?.enabled === "boolean") global.enabled = input.enabled;
        if (typeof input?.yoloEdits === "boolean") global.yoloEdits = input.yoloEdits;
        await save("global", global);
        emit("*");
        return statePayload(input ?? {});
      },
      setSetting: async (input: any) => {
        if (input?.key === "openLogs") return statePayload(input ?? {});
        if (input?.key === "resetGuard") {
          if (input?.sessionID) {
            const { rootID } = await sessionInfo(input.sessionID);
            await ensureRecords(rootID);
            guards.set(rootID, idleGuard());
            emit(rootID);
          }
          return statePayload(input ?? {});
        }
        const info = input?.sessionID
          ? await sessionInfo(input.sessionID)
          : { projectKey: `dir:${input?.directory ?? ctx.location?.directory}` };
        const proj = await project(info.projectKey);
        const key = input?.key as SettingKey;
        if (visibleRows(SETTING_ROWS, await memoryAvailable()).some((row) => row.key === key)) {
          if (key === "model") {
            if (typeof input?.value === "string" && parseModel(input.value)) proj.settings = { ...proj.settings, model: input.value };
          } else {
            proj.settings = adjust(proj.settings, key, input?.input ?? "toggle");
          }
          await save(`project:${info.projectKey}`, proj);
        }
        emit("*");
        return statePayload(input ?? {});
      },
      setOverride: async (input: any) => {
        const record = byID.get(String(input?.recordID));
        const value = input?.value as Override;
        if (record && OVERRIDES.includes(value)) {
          const sess = await session(record.rootID);
          const key = exactKey(record.action, record.subject);
          if (value === "allow") {
            const goal = latestUserText(await messagesFor(record.sessionID));
            addAllow(sess, options.alikeTools, record.action, record.subject, goal);
          } else if (modeFor(sess, options.alikeTools, record.action, record.subject) === "allow") {
            removeAllow(sess, options.alikeTools, record.action, record.subject);
            // A whole-tool allow is marked on the row it was set on; clear that marker too.
            if (!isAlikeTool(record.action, options.alikeTools)) clearToolAllows(sess, record.action);
          }
          // The row an allow is set on keeps an `allow` override: it marks where the rule came from.
          if (value === "check") delete sess.overrides[key];
          else sess.overrides[key] = value;
          approvedExact.get(record.rootID)?.delete(key);
          refused.get(record.rootID)?.delete(key);
          await save(`session:${record.rootID}`, sess);
          emit(record.rootID);
        }
        return statePayload({ sessionID: input?.sessionID ?? record?.sessionID });
      },
    } as any);

    notify = (rootID: string) => {
      void registration.events.emit("changed", { rootID }).catch(() => {});
    };

    // ---------------------------------------------------------------- denials

    const noteApproval = (rootID: string) => {
      const counts = denials.get(rootID);
      if (counts) counts.consecutive = 0;
    };

    /** Denies, unless too many denials in a row (or in total) say the user should look. Either way: on guard. */
    const deny = (event: any, record: CallRecord, source: RecordSource, reason: string) => {
      guards.set(record.rootID, onDeny(guards.get(record.rootID) ?? idleGuard(), { subject: record.subject, reason }));
      const counts = denials.get(record.rootID) ?? { consecutive: 0, total: 0 };
      counts.consecutive += 1;
      counts.total += 1;
      denials.set(record.rootID, counts);
      if (counts.consecutive >= MAX_CONSECUTIVE_DENIALS || counts.total >= MAX_TOTAL_DENIALS) {
        counts.consecutive = 0;
        event.effect = "ask";
        event.message = `auto-mode blocked ${counts.total} actions in this session, so you decide this one. Last reason: ${reason}`;
        settle(record, "ask", "backstop", event.message);
        return;
      }
      event.effect = "deny";
      event.message = `auto-mode: ${reason.replace(/[.\s]+$/, "")}. ${DENY_SUFFIX}`;
      settle(record, "deny", source, reason);
    };

    const allow = (event: any, record: CallRecord, source: RecordSource, reason: string) => {
      event.effect = "allow";
      event.message = `auto-mode: ${reason}`;
      noteApproval(record.rootID);
      settle(record, "allow", source, reason);
    };

    const escalate = (event: any, record: CallRecord, source: RecordSource, reason: string) => {
      event.effect = "ask";
      event.message = `auto-mode: ${reason}`;
      noteApproval(record.rootID);
      settle(record, "ask", source, reason);
    };

    // ---------------------------------------------------------------- review

    /**
     * Reviews run as transient `ctx.session.generate` calls on the session that
     * needs them: no new session, nothing added to history, and the call
     * reports tokens and cost. Two hooks shape them (registered below):
     * `experimental.model.resolve` swaps in the reviewer model, `generate`
     * replaces the system prompt and drops the session history so only the
     * review question is sent. A call is only trusted when the `generate` hook
     * saw its nonce; otherwise the answer is discarded and the call is redone
     * through `generate.text` (no cost reported, counted as unpriced).
     */
    type ModelRef = { providerID: string; id: string };
    interface PendingReview {
      sessionID: string;
      model: ModelRef;
      system: string;
      shaped: boolean;
      mismatch: boolean;
    }
    const pending = new Map<string, PendingReview>();
    /** `session + reviewer provider` pairs where model.resolve can't switch providers. */
    const textOnly = new Set<string>();
    const pairKey = (sessionID: string, model: ModelRef) => `${sessionID}\u0000${model.providerID}`;
    let sessionPathBroken = false;
    let nonceCounter = 0;

    const viaText = async (model: ModelRef, system: string, question: string): Promise<{ text: string; usage?: CallUsage } | undefined> => {
      const api = c.experimental?.generate?.text ? c.experimental.generate : c.generate;
      const prompt = `${system}\n\n${question}`;
      for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt++) {
        try {
          const result = await withTimeout<any>(api.text({ prompt, model }), REVIEW_TIMEOUT_MS);
          if (typeof result?.text === "string") return { text: result.text };
        } catch (error) {
          logError(`review attempt ${attempt} (generate.text)`, error);
        }
      }
      return undefined;
    };

    const viaSession = async (
      sessionID: string,
      model: ModelRef,
      system: string,
      question: string,
    ): Promise<{ text: string; usage?: CallUsage } | "unavailable"> => {
      const nonce = `am-${Date.now().toString(36)}-${(nonceCounter++).toString(36)}`;
      const entry: PendingReview = { sessionID, model, system, shaped: false, mismatch: false };
      pending.set(nonce, entry);
      try {
        const result = await withTimeout<any>(
          ctx.session.generate({ sessionID, prompt: `${question}\n\n[review ${nonce}]` } as any),
          REVIEW_TIMEOUT_MS,
        );
        if (entry.mismatch) {
          textOnly.add(pairKey(sessionID, model));
          return "unavailable";
        }
        if (!entry.shaped) {
          sessionPathBroken = true;
          logError("session.generate ran without the generate hook; using generate.text from now on");
          return "unavailable";
        }
        if (typeof result?.text !== "string") return "unavailable";
        return { text: result.text, usage: { cost: result.cost, tokens: result.tokens } };
      } catch (error) {
        logError("session.generate review failed; falling back to generate.text", error);
        sessionPathBroken = true;
        return "unavailable";
      } finally {
        pending.delete(nonce);
      }
    };

    const ask = async (
      sessionID: string,
      rootID: string,
      model: ModelRef,
      system: string,
      question: string,
    ): Promise<string | undefined> => {
      let result: { text: string; usage?: CallUsage } | "unavailable" | undefined = "unavailable";
      if (!sessionPathBroken && !textOnly.has(pairKey(sessionID, model))) result = await viaSession(sessionID, model, system, question);
      if (result === "unavailable") result = await viaText(model, system, question);
      if (!result) return undefined;
      costs.set(rootID, addUsage(costs.get(rootID) ?? emptyCost(), result.usage));
      emit(rootID);
      return result.text;
    };

    const review = async (
      event: any,
      record: CallRecord,
      info: SessionInfo,
      messages: unknown[],
      settings: ProjectSettings,
      model: ModelRef,
    ) => {
      record.status = "reviewing";
      record.reason = "";
      emit(record.rootID);

      const transcript = buildTranscript(messages, settings.messages, event.source?.id);
      const inSubagent = info.rootID !== event.sessionID;
      const mainTranscript = inSubagent
        ? buildTranscript(await messagesFor(info.rootID), settings.messages).text
        : undefined;
      const docs = collectDocuments({
        directory: info.directory,
        settings: effectiveSettings(settings, await memoryAvailable()),
        memoryDir: options.memoryDir,
        memoryFile: options.memoryFile,
      });
      // On guard: this review uses up one of the guarded calls (a deny resets it to the full count).
      const guard = guards.get(record.rootID) ?? idleGuard();
      const guarded = onGuard(guard);
      if (guarded) guards.set(record.rootID, onReview(guard));

      const request: ReviewRequest = {
        action: event.action,
        subject: record.subject,
        agent: event.agent,
        directory: info.directory,
        transcript: transcript.text,
        background: docs.background,
        instructions: docs.instructions,
        mainTranscript,
        recentDenials: guarded ? guard.recent : undefined,
      };
      const system = systemPrompt(policy, docs.background, docs.instructions);
      const key = exactKey(record.action, record.subject);
      if (info.provider && info.provider !== model.providerID) textOnly.add(pairKey(event.sessionID, model));

      if (!guarded) {
        const triage = await ask(event.sessionID, record.rootID, model, system, questionPrompt(request, "triage"));
        if (triage === undefined) return escalate(event, record, "error", "the reviewer did not answer, so you decide");
        if (parseTriage(triage) === "allow") {
          approved(record.rootID).add(key);
          return allow(event, record, "triage", "quick check found nothing risky");
        }
      }

      const answer = await ask(event.sessionID, record.rootID, model, system, questionPrompt(request, "reason"));
      if (answer === undefined) return escalate(event, record, "error", "the reviewer did not answer, so you decide");
      const { decision, reason } = parseDecision(answer);
      if (decision === "allow") {
        approved(record.rootID).add(key);
        return allow(event, record, "reviewer", reason);
      }
      if (decision === "deny") {
        const map = refused.get(record.rootID) ?? new Map();
        map.set(key, transcript.lastUserID);
        refused.set(record.rootID, map);
        return deny(event, record, "reviewer", reason);
      }
      return escalate(event, record, "reviewer", reason);
    };

    /** "Always allow" on a `alikeTools` tool: does the reviewer find this call alike to one the user allowed? */
    const alikeCheck = async (
      event: any,
      record: CallRecord,
      info: SessionInfo,
      messages: unknown[],
      settings: ProjectSettings,
      model: ModelRef,
      alikes: AlikeEntry[],
    ): Promise<AlikeEntry | undefined> => {
      record.status = "reviewing";
      record.reason = "";
      emit(record.rootID);
      const docs = collectDocuments({
        directory: info.directory,
        settings: effectiveSettings(settings, await memoryAvailable()),
        memoryDir: options.memoryDir,
        memoryFile: options.memoryFile,
      });
      const request: ReviewRequest = {
        action: event.action,
        subject: record.subject,
        agent: event.agent,
        directory: info.directory,
        transcript: buildTranscript(messages, settings.messages, event.source?.id).text,
        background: docs.background,
        instructions: docs.instructions,
      };
      const system = systemPrompt(policy, docs.background, docs.instructions);
      if (info.provider && info.provider !== model.providerID) textOnly.add(pairKey(event.sessionID, model));
      const answer = await ask(event.sessionID, record.rootID, model, system, alikePrompt(request, alikes));
      const index = answer === undefined ? undefined : parseAlike(answer, alikes.length);
      return index === undefined ? undefined : alikes[index];
    };

    const approved = (rootID: string) => {
      let set = approvedExact.get(rootID);
      if (!set) approvedExact.set(rootID, (set = new Set()));
      return set;
    };

    // ---------------------------------------------------------------- hooks

    const describe = (tool: string, input: unknown): string => {
      if (input && typeof input === "object") {
        const record = input as Record<string, unknown>;
        for (const key of ["command", "filePath", "path", "url", "query", "pattern", "description"]) {
          if (typeof record[key] === "string") return record[key] as string;
        }
        try {
          return JSON.stringify(input);
        } catch {}
      }
      return typeof input === "string" ? input : tool;
    };

    const pendingFor = (sessionID: string) => [...pending.values()].filter((entry) => entry.sessionID === sessionID);

    const resolveHook = await (ctx.session.hook as any)("experimental.model.resolve", (event: any) => {
      if (event.kind !== "generate") return;
      const entries = pendingFor(event.sessionID);
      if (entries.length === 0) return;
      // Concurrent reviews in one session share the same reviewer (one project setting).
      const model = entries[0]!.model;
      if (event.model?.providerID === model.providerID) {
        event.model = { providerID: model.providerID, id: model.id };
      } else {
        // Only models of the session's own provider can be swapped in.
        for (const entry of entries) entry.mismatch = true;
      }
    });

    const textOf = (message: any): string => {
      const content = message?.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n");
    };

    const generateHook = await (ctx.session.hook as any)("generate", (event: any) => {
      if (pending.size === 0 || !Array.isArray(event.messages)) return;
      const last = event.messages.at(-1);
      const text = textOf(last);
      const match = text.match(/\[review (am-[a-z0-9]+-[a-z0-9]+)\]\s*$/);
      const entry = match ? pending.get(match[1]!) : undefined;
      if (!entry) return;
      // Only the review question goes out: no session history, no tools.
      event.system = [{ type: "text", text: entry.system }];
      event.messages = [last];
      event.tools = {};
      event.options = { ...(event.options ?? {}), maxTokens: entry.mismatch ? 1 : 400 };
      entry.shaped = true;
    });

    const before = await ctx.tool.hook("execute.before", async (event: any) => {
      try {
        if (byID.has(String(event.id))) return;
        const info = await sessionInfo(event.sessionID);
        await ensureRecords(info.rootID);
        upsert({
          id: String(event.id),
          sessionID: event.sessionID,
          rootID: info.rootID,
          action: event.tool,
          subject: describe(event.tool, event.input),
          resources: [],
          status: global.enabled ? "running" : "off",
          source: global.enabled ? "tool" : "off",
          reason: "",
          at: Date.now(),
          edit: EDIT_ACTIONS.has(event.tool),
        });
      } catch (error) {
        logError("execute.before", error);
      }
    });

    const after = await ctx.tool.hook("execute.after", async (event: any) => {
      const record = byID.get(String(event.id));
      if (!record || record.status !== "running") return;
      record.status = "allow";
      record.source = "tool";
      record.reason = event.status === "error" ? "ran without a permission check (failed)" : "ran without a permission check";
      emit(record.rootID);
    });

    const permission = await ctx.permission.hook("evaluate", async (event: any) => {
      let record: CallRecord | undefined;
      try {
        const info = await sessionInfo(event.sessionID);
        await ensureRecords(info.rootID);
        const callID = event.source?.id ? String(event.source.id) : undefined;
        const resources: string[] = [...(event.resources ?? [])];
        // MCP tools and the like check the catch-all "*"; the reviewer and the exact-command cache need the real input.
        const wildcard = event.action !== "shell" && resources.every((resource) => resource === "*");
        const messages = event.action === "shell" || wildcard ? await messagesFor(event.sessionID) : undefined;
        const command = event.action === "shell" ? findToolCommand(messages ?? [], callID) : undefined;
        const call = wildcard ? findToolCall(messages ?? [], callID) : undefined;
        const subject =
          event.action === "shell"
            ? command ?? resources.join(" && ")
            : call
              ? call.name === event.action
                ? describe(call.name, call.input)
                : `inside ${call.name}: ${describe(call.name, call.input)}`
              : resources.join("\n");

        // One tool call can check several actions (shell checks external_directory first); give each its own row.
        const existing = callID ? byID.get(callID) : undefined;
        const tool = existing?.status === "running" || existing?.status === "off" ? existing.action : undefined;
        const id =
          callID && (!existing || existing.status === "running" || existing.status === "off")
            ? callID
            : `${callID ?? "eval"}:${event.action}:${Date.now()}`;
        record = byID.get(id) ?? {
          id,
          sessionID: event.sessionID,
          rootID: info.rootID,
          action: event.action,
          subject,
          resources,
          status: "running",
          source: "tool",
          reason: "",
          at: Date.now(),
          edit: EDIT_ACTIONS.has(event.action),
        };
        Object.assign(record, { action: event.action, subject, resources, edit: EDIT_ACTIONS.has(event.action) });
        upsert(record);

        if (!global.enabled) return settle(record, "off", "off", `auto mode is off; OpenCode decided: ${event.effect}`);

        const rules = configuredRules(info.directory, event.agent);
        if (userDecides(rules, event.action, resources)) {
          return settle(record, event.effect, "config", `your permission rules decide this (${event.effect})`);
        }

        const sess = await session(info.rootID);
        const proj = await project(info.projectKey);
        const key = exactKey(event.action, subject);
        const override = sess.overrides[key];
        if (override === "deny") return deny(event, record, "override", "you set this command to deny for this session");
        if (override === "allow") return allow(event, record, "override", "you allowed this command for this session");
        if (override !== "check" && !isAlikeTool(event.action, options.alikeTools) && sess.always.includes(event.action)) {
          const origin = Object.entries(sess.overrides).find(
            ([other, mode]) => mode === "allow" && other.startsWith(`${event.action}\u0000`) && other !== key,
          );
          if (origin) record.allowedBy = { action: event.action, subject: origin[0].slice(event.action.length + 1) };
          return allow(event, record, "always", "you always allowed this tool for this session");
        }

        const tier = classify({ action: event.action, resources, command, tool, yoloEdits: global.yoloEdits });
        if (tier.tier === "deny") return deny(event, record, "catastrophic", tier.reason);
        if (tier.tier === "allow") return allow(event, record, tier.yolo ? "yolo" : "read-only", tier.reason);

        if (proj.settings.review === "prompts" && event.effect !== "ask") {
          return settle(record, event.effect, "config", "OpenCode allows this and review is set to prompts only");
        }
        const reviewer = reviewerFor(proj.settings);
        if (!reviewer) return escalate(event, record, "error", NO_MODEL);

        if (override !== "check" && !onGuard(guards.get(info.rootID)) && approved(info.rootID).has(key)) {
          return allow(event, record, "cache", "the reviewer allowed this exact command earlier in this session");
        }
        const all = messages ?? (await messagesFor(event.sessionID));
        const lastUserID = buildTranscript(all, 1).lastUserID;
        const refusedFor = refused.get(info.rootID);
        if (override !== "check" && refusedFor?.has(key) && refusedFor.get(key) === lastUserID) {
          return deny(event, record, "refused", "the reviewer refused this exact command already; it stays refused until you send a new message");
        }
        const alikes = sess.alikes.filter((entry) => entry.action === event.action);
        if (override !== "check" && alikes.length > 0 && !onGuard(guards.get(info.rootID))) {
          const match = await alikeCheck(event, record, info, all, proj.settings, reviewer, alikes);
          if (match) {
            record.allowedBy = { action: match.action, subject: match.subject };
            return allow(event, record, "alike", "the reviewer found it alike to a call you always allowed this session");
          }
        }

        await review(event, record, info, all, proj.settings, reviewer);
      } catch (error) {
        logError("evaluate", error);
        if (record && global.enabled) escalate(event, record, "error", "auto-mode hit an error, so you decide");
      }
    });

    // "Always allow" on a prompt, for this session: the whole tool, or for `alikeTools` tools an alike rule the reviewer checks.
    const abort = new AbortController();
    const asked = new Map<string, { sessionID: string; action: string; callID?: string }>();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["permission.asked", "permission.replied"],
          signal: abort.signal,
        } as any) as AsyncIterable<any>) {
          if (event.type === "permission.asked") {
            const data = event.data;
            asked.set(data.id, { sessionID: data.sessionID, action: data.action, callID: data.source?.id });
          } else if (event.type === "permission.replied") {
            const request = asked.get(event.data.requestID);
            asked.delete(event.data.requestID);
            if (!request?.callID || event.data.reply !== "always") continue;
            const info = await sessionInfo(request.sessionID);
            await ensureRecords(info.rootID);
            // One tool call can hold several rows (`<callID>:<action>:<time>`); take the latest for this action.
            const record = [...(records.get(info.rootID) ?? [])]
              .reverse()
              .find((r) => r.action === request.action && (r.id === request.callID || r.id.startsWith(`${request.callID}:`)));
            if (!record) continue;
            const sess = await session(info.rootID);
            // Same as "allow" on the row in the modal.
            addAllow(sess, options.alikeTools, record.action, record.subject, latestUserText(await messagesFor(request.sessionID)));
            sess.overrides[exactKey(record.action, record.subject)] = "allow";
            await save(`session:${info.rootID}`, sess);
            emit(info.rootID);
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) logError("event subscription", error);
      }
    })();

    return async () => {
      abort.abort();
      const flushes = [...saveTimers.entries()].map(([rootID, timer]) => {
        clearTimeout(timer);
        return save(`records:${rootID}`, snapshot(rootID));
      });
      saveTimers.clear();
      await Promise.allSettled([
        ...flushes,
        permission.dispose(),
        before.dispose(),
        after.dispose(),
        resolveHook.dispose(),
        generateHook.dispose(),
        registration.dispose(),
      ]);
    };
  },
});
