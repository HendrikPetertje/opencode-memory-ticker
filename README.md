# memory-ticker

An OpenCode V2 plugin that owns everything about `.aim` memory:

- registers the `memory` MCP server
  ([mcp-knowledge-graph](https://www.npmjs.com/package/mcp-knowledge-graph)),
- adds a footer widget with entity, observation and relation counts for global
  and project memory,
- lets you browse the memories: click a segment, or use the keybinds below.

## Requirements

- OpenCode V2
- `npx` (Node.js) or `pnpm`, used to launch the MCP server. `npx` is tried
  first, `pnpm dlx` is the fallback.

## Installation

Clone it (or add it as a git submodule) somewhere your OpenCode config can reach:

```bash
cd ~/.config/opencode
git submodule add https://github.com/<your-user>/opencode-memory-ticker.git configured-plugins/memory-ticker
# or, without submodules:
git clone https://github.com/<your-user>/opencode-memory-ticker.git configured-plugins/memory-ticker
```

There is no build step and no npm package: OpenCode loads the TypeScript
directly. Add the plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  {
    "package": "./configured-plugins/memory-ticker",
    "options": {
      "globalPath": "~/.config/.aim"
    }
  }
]
```

Restart OpenCode. To update later, run `git pull` in the plugin folder (or
`git submodule update --remote configured-plugins/memory-ticker`).

## Options

| Option | Default | |
|---|---|---|
| `globalPath` | `~/.aim` | where the global memory lives |

Project memory needs no configuration: the server uses a `.aim/` folder in the
project when one exists.

## Keybinds

| Default | Command id | Does |
|---|---|---|
| `<leader>k` | `memory-ticker.project` | browse project memory |
| `<leader>shift+k` | `memory-ticker.global` | browse global memory |

Override them in `cli.json` under `keybinds`, by command id:

```jsonc
"keybinds": {
  "memory-ticker.project": "<leader>m",
  "memory-ticker.global": "<leader>shift+m"
}
```

## How it works

- `index.ts` (server part) registers the `memory` MCP server and exposes the
  resolved global path over RPC.
- `tui.tsx` (TUI part) does not receive plugin options, so it asks the server
  part for the path over RPC (see `rpc.ts`), then reads the memory files to
  render the footer widget.

## License

MIT
