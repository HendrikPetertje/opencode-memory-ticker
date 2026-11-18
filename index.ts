/**
 * Registers the `memory` MCP server (mcp-knowledge-graph) so the plugin owns
 * everything `.aim`: the server here, the footer widget in ./tui.tsx.
 *
 * Configure the global store once, in opencode.jsonc:
 *
 *   "plugins": [
 *     { "package": "./configured-plugins/memory-ticker", "options": { "globalPath": "~/.config/.aim" } }
 *   ]
 *
 * Without `globalPath` it falls back to ~/.aim. Project memory needs no config:
 * the server uses a `.aim/` directory in the project when one exists.
 * The TUI part does not receive plugin options, so it asks this server part
 * for the path over RPC (see rpc.ts).
 */
import { Plugin } from "@opencode/plugin";
import { resolveGlobalDir } from "./config.ts";
import { MemoryConfig } from "./rpc.ts";

// The path arrives as $1, so it never needs shell quoting. Falls back to pnpm when npx fails.
const SCRIPT =
  'npx -y mcp-knowledge-graph --memory-path "$1" || pnpm --pm-on-fail=ignore --reporter=silent dlx mcp-knowledge-graph --memory-path "$1"';

export default Plugin.define({
  id: "memory-ticker",
  async setup(ctx) {
    const globalDir = resolveGlobalDir(ctx.options);
    await ctx.rpc.register(MemoryConfig, { globalDir: async () => ({ path: globalDir }) });
    await ctx.mcp.transform((editor) => {
      editor.set("memory", {
        type: "local",
        command: ["sh", "-c", SCRIPT, "sh", globalDir],
      });
    });
  },
});
