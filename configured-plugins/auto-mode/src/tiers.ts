import { isAbsolute, normalize } from "node:path";
import { scanShell, stripAssignments, words } from "./shell.ts";

export type Tier = "allow" | "deny" | "review";

export interface Classification {
  tier: Tier;
  reason: string;
  /** Set when the instant allow came from file-edit yolo mode. */
  yolo?: boolean;
}

/** Actions that never change anything, or whose nested calls are checked on their own (Code Mode). */
const SAFE_ACTIONS = new Set([
  "read",
  "glob",
  "grep",
  "websearch",
  "question",
  "skill",
  "execute",
  // Starting a subagent: the check only carries the agent ID, never its task, so
  // there is nothing to judge. Every call the subagent makes is reviewed itself.
  "subagent",
  "task",
  "opencode_list_mcp_resources",
  "opencode_read_mcp_resource",
]);

export const EDIT_ACTIONS = new Set(["edit", "write", "patch"]);

const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "file", "stat", "du", "df", "tree",
  "rg", "grep", "ag", "ack", "fd", "which", "whereis", "type", "pwd", "echo", "printf", "date",
  "whoami", "hostname", "uname", "uptime", "id", "groups", "realpath", "basename", "dirname",
  "diff", "cmp", "md5", "md5sum", "shasum", "sha256sum", "jq", "yq", "xq", "sort", "uniq", "cut",
  "tr", "column", "nl", "tac", "rev", "tokei", "cd", "true", "false", "test", "[",
]);

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "blame", "shortlog", "describe", "rev-parse", "ls-files",
  "ls-tree", "cat-file", "reflog", "grep", "merge-base", "whatchanged",
]);

const CATASTROPHIC: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME)\/?(\s|$|\*)/,
  /\bsudo\b/,
  /\bmkfs(\.|\s)/,
  /\bdd\s+[^|;&]*\bof=\/dev\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\bdiskutil\s+(erase|zero|partition)/,
];

const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)\b.*|credentials(\..*)?|secrets?(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;
/** A dot segment that looks like a file or folder name, not a jq filter or regex (`.time[0]`, `.foo|bar`). */
const DOT_NAME = /^\.[A-Za-z0-9_][A-Za-z0-9_.@+-]*\*?$/;

/**
 * A path that may hold secrets or private config: any dotfile or dot folder
 * along the path (`.env`, `~/.aws/credentials`, `.config/gh/hosts.yml`), or a
 * well-known secret file name. Reading these puts their content in the
 * model's context and the provider's logs, so they are reviewed, not instant.
 */
export function sensitivePath(path: string): boolean {
  return path.split("/").some((segment) => DOT_NAME.test(segment) || SECRET_NAME.test(segment));
}

/** Also catches paths inside flags and assignments: `--env-file=.env`, `KEY=$HOME/.aws/x`. */
function mentionsSensitive(token: string): boolean {
  return token.split(/[=:,]/).some((part) => part.length > 1 && sensitivePath(part));
}

/** Programs whose first plain argument is a filter expression, not a path (`jq .name file`). */
const FILTER_FIRST = new Set(["jq", "yq", "xq"]);

/** Arguments that could name a file: drops the filter of jq-like tools. */
function pathArgs(program: string, args: string[]): string[] {
  if (!FILTER_FIRST.has(program)) return args;
  const filter = args.findIndex((arg) => !arg.startsWith("-"));
  return filter === -1 ? args : args.filter((_, index) => index !== filter);
}

function readOnlySegment(segment: string): boolean {
  const tokens = stripAssignments(words(segment));
  const [program, ...args] = tokens;
  if (!program) return true;
  if (pathArgs(program, args).some(mentionsSensitive)) return false;

  if (program === "git") {
    const sub = args.find((arg) => !arg.startsWith("-"));
    if (!sub) return false;
    if (GIT_READ_ONLY.has(sub)) return true;
    if (sub === "branch" || sub === "tag" || sub === "remote" || sub === "stash") {
      const rest = args.slice(args.indexOf(sub) + 1);
      if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
      const listing = new Set(["-a", "-r", "-v", "-vv", "--list", "-l", "--show-current", "--all", "--merged", "--no-merged"]);
      return rest.every((arg) => listing.has(arg) || (sub === "remote" && arg === "show"));
    }
    return false;
  }
  if (program === "find") return !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)/.test(arg));
  if (program === "sed") return !args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"));
  if (program === "npm" || program === "pnpm" || program === "yarn") {
    return ["list", "ls", "view", "info", "outdated", "why", "explain"].includes(args[0] ?? "");
  }
  if (["node", "bun", "python", "python3", "go", "cargo", "deno"].includes(program)) {
    return args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]!);
  }
  return READ_ONLY_PROGRAMS.has(program);
}

function insideProject(resource: string): boolean {
  if (!resource || isAbsolute(resource) || resource.startsWith("~")) return false;
  const normalized = normalize(resource);
  return normalized !== ".." && !normalized.startsWith("../");
}

export interface ClassifyInput {
  action: string;
  resources: readonly string[];
  /** The full command as the agent wrote it, when it is a shell call. */
  command?: string;
  /** The tool that triggered the check, when known (external_directory is checked on behalf of a tool). */
  tool?: string;
  yoloEdits: boolean;
}

const READ_TOOLS = new Set(["read", "glob", "grep"]);

export function classify(input: ClassifyInput): Classification {
  const { action, resources } = input;

  if (action === "read" && resources.some(sensitivePath)) {
    return { tier: "review", reason: "reads a dotfile or secret file" };
  }

  if (SAFE_ACTIONS.has(action)) return { tier: "allow", reason: `${action} is read-only` };

  if (action === "external_directory" && input.tool && READ_TOOLS.has(input.tool)) {
    return { tier: "allow", reason: `${input.tool} outside the project is read-only` };
  }

  if (EDIT_ACTIONS.has(action)) {
    if (input.yoloEdits && resources.length > 0 && resources.every((r) => insideProject(r) && !sensitivePath(r))) {
      return { tier: "allow", reason: "file edit inside the project (yolo)", yolo: true };
    }
    if (resources.some(sensitivePath)) return { tier: "review", reason: "edits a dotfile or secret file" };
    return { tier: "review", reason: input.yoloEdits ? "file edit outside the project" : "file edit" };
  }

  if (action === "shell") {
    const command = input.command?.trim() || resources.join(" && ");
    if (!command) return { tier: "allow", reason: "empty command" };
    const pattern = CATASTROPHIC.find((regex) => regex.test(command));
    if (pattern) return { tier: "deny", reason: `matches a catastrophic pattern (${pattern.source})` };
    const scan = scanShell(command);
    if (scan.dynamic) return { tier: "review", reason: "command uses substitution or eval" };
    if (scan.writes) return { tier: "review", reason: "command writes to a file" };
    if (scan.segments.every(readOnlySegment)) return { tier: "allow", reason: "read-only command" };
    const touchesSecrets = scan.segments.some((segment) => {
      const [program = "", ...args] = stripAssignments(words(segment));
      return pathArgs(program, args).some(mentionsSensitive);
    });
    return { tier: "review", reason: touchesSecrets ? "command touches a dotfile or secret file" : "command may change something" };
  }

  return { tier: "review", reason: `${action} needs review` };
}
