export interface ShellScan {
  /** Simple commands, split on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. */
  segments: string[];
  /** Command or process substitution (`$(...)`, backticks, `<(...)`), or `eval`. */
  dynamic: boolean;
  /** Output redirected to a file. `2>&1` and `> /dev/null` do not count. */
  writes: boolean;
}

const HARMLESS_TARGET = /^(&[0-9-]|\/dev\/null\b)/;

export function scanShell(command: string): ShellScan {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let dynamic = false;
  let writes = false;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      current += char + next;
      i++;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(")) dynamic = true;
    if (quote === '"') {
      current += char;
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") dynamic = true;
    if (char === ">") {
      const rest = command.slice(i + 1).replace(/^>/, "").trimStart();
      if (!HARMLESS_TARGET.test(rest)) writes = true;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      flush();
      continue;
    }
    if (char === "&") {
      if (next === "&") i++;
      else if (command[i - 1] === ">" || next === ">") {
        current += char;
        continue;
      }
      flush();
      continue;
    }
    if (char === "|") {
      if (next === "|") i++;
      flush();
      continue;
    }
    current += char;
  }
  flush();

  if (segments.some((segment) => /^(eval|exec|source|\.)\s/.test(segment))) dynamic = true;
  return { segments, dynamic, writes };
}

/** Splits a simple command into words, honouring quotes. Good enough for matching, not for execution. */
export function words(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let has = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
      continue;
    }
    current += char;
  }
  if (has || current) out.push(current);
  return out;
}

/** Drops leading `VAR=value` assignments. */
export function stripAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i);
}
