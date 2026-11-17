/** OpenCode permission wildcards: `*` is zero or more characters (including `/`), `?` exactly one. */
export function wildcard(value: string, pattern: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += "[\\s\\S]*";
    else if (char === "?") regex += "[\\s\\S]";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`).test(value);
}
