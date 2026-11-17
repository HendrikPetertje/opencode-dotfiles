import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/** OpenCode's global config directory. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

/**
 * Logs and decision records live outside every watched directory: writing
 * under the config dir or a project makes OpenCode reload plugins in a loop.
 */
export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-auto-mode");
}
