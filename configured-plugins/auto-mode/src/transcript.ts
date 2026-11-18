const MAX_TOOL_INPUT = 1500;

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolInput(part: Record<string, any>): unknown {
  return asRecord(part.state)?.input;
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  const record = asRecord(input);
  if (record && typeof record.command === "string") return record.command;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

export interface Transcript {
  text: string;
  /** ID of the latest user message; a new one lifts "refused stays refused". */
  lastUserID?: string;
}

/**
 * The latest `count` user messages and every tool call made since the oldest
 * of them. Assistant prose and tool output are left out on purpose: they are
 * where prompt injection lives, and the reviewer must judge what *you* asked.
 */
export function buildTranscript(messages: readonly unknown[], count: number, skipToolID?: string): Transcript {
  const records = messages.map(asRecord).filter((m): m is Record<string, any> => m !== undefined);
  const userIndexes = records.flatMap((m, i) => (m.type === "user" ? [i] : []));
  const lastUser = userIndexes.at(-1);
  const lastUserID = lastUser === undefined ? undefined : String(records[lastUser]!.id ?? lastUser);
  if (count === 0 || userIndexes.length === 0) return { text: "(no user messages included)", lastUserID };

  const start = userIndexes[Math.max(0, userIndexes.length - count)]!;
  const lines: string[] = [];
  for (const message of records.slice(start)) {
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
      lines.push(`USER: ${message.text.trim()}`);
      continue;
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content.map(asRecord)) {
      if (part?.type !== "tool" || part.id === skipToolID) continue;
      lines.push(`TOOL CALL ${part.name}: ${truncate(formatInput(toolInput(part)), MAX_TOOL_INPUT)}`);
    }
  }
  return { text: lines.join("\n") || "(no user messages included)", lastUserID };
}

/** The text of the latest user message, trimmed and capped: the goal an "always allow" was given for. */
export function latestUserText(messages: readonly unknown[], max = 500): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message?.type === "user" && typeof message.text === "string" && message.text.trim()) {
      return truncate(message.text.trim(), max);
    }
  }
  return undefined;
}

/** The tool call with this ID: its name and input as the agent wrote them. */
export function findToolCall(messages: readonly unknown[], toolID: string | undefined): { name: string; input: unknown } | undefined {
  if (!toolID) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content.map(asRecord)) {
      if (part?.type === "tool" && part.id === toolID) return { name: String(part.name ?? ""), input: toolInput(part) };
    }
  }
  return undefined;
}

/** The shell command exactly as the agent wrote it, before OpenCode split it into sub-commands. */
export function findToolCommand(messages: readonly unknown[], toolID: string | undefined): string | undefined {
  const command = asRecord(findToolCall(messages, toolID)?.input)?.command;
  return typeof command === "string" ? command : undefined;
}
