import { homedir } from "node:os";
import { resolve } from "node:path";

/** Used when the `globalPath` plugin option is not set (mcp-knowledge-graph's conventional location). */
export const DEFAULT_GLOBAL_PATH = "~/.aim";

export function resolveGlobalDir(options: Record<string, unknown> | undefined): string {
  const raw = typeof options?.globalPath === "string" && options.globalPath.trim() ? options.globalPath.trim() : DEFAULT_GLOBAL_PATH;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? `${homedir()}/${raw.slice(2)}` : raw;
  return resolve(expanded);
}
