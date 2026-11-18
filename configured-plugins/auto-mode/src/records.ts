import type { Override } from "./overrides.ts";

export type RecordStatus =
  /** Tool started; no permission check seen (yet). */
  | "running"
  /** Waiting on the reviewer model. */
  | "reviewing"
  | "allow"
  | "deny"
  /** Left to the user (permission prompt). */
  | "ask"
  /** Auto mode was off; OpenCode decided. */
  | "off";

export type RecordSource =
  | "tool"
  | "read-only"
  | "catastrophic"
  | "yolo"
  | "config"
  | "override"
  | "always"
  | "alike"
  | "cache"
  | "refused"
  | "triage"
  | "reviewer"
  | "backstop"
  | "error"
  | "off";

export interface CallRecord {
  id: string;
  sessionID: string;
  /** Root session; overrides apply to the whole session family. */
  rootID: string;
  action: string;
  /** Full command for shell, resources joined by newlines otherwise. */
  subject: string;
  resources: string[];
  status: RecordStatus;
  source: RecordSource;
  reason: string;
  at: number;
  /** Shows which edit-type calls the yolo filter hides. */
  edit: boolean;
  override?: Override;
}

export function shorten(record: Pick<CallRecord, "action" | "subject">, max: number): string {
  const flat = record.subject.replace(/\s+/g, " ").trim();
  const text = record.action === "shell" ? flat : `${record.action} ${flat}`.trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}
