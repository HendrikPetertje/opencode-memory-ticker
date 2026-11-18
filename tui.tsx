/**
 * Footer counter for the `memory` MCP knowledge graph (mcp-knowledge-graph).
 * Shows entities/observations/relations for the global and project stores,
 * as coloured text, refreshes when the files change, and opens a scrollable
 * dialog listing the memories when a segment is clicked.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { useTerminalDimensions } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { resolveGlobalDir } from "./config.ts";
import { MemoryConfig } from "./rpc.ts";

const FILE = "memory-current.jsonl";
let GLOBAL_DIR = resolveGlobalDir(undefined);

type Counts = { e: number; o: number; r: number } | undefined;

function count(file: string): Counts {
  if (!existsSync(file)) return undefined;
  const counts = { e: 0, o: 0, r: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "entity") {
        counts.e++;
        counts.o += Array.isArray(row.observations) ? row.observations.length : 0;
      } else if (row.type === "relation") counts.r++;
    } catch {}
  }
  return counts;
}

function projectDir(start: string | undefined): string | undefined {
  let dir = start;
  while (dir) {
    const candidate = join(dir, ".aim");
    if (candidate !== GLOBAL_DIR && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const ICON = { globe: "\uF0AC", folder: "\uF07B", folderOpen: "\uF115" };
const COMPACT_BELOW = 100;
const MODAL_MARGIN = 2;
/** OpenCode's dialog adds one row of top padding around the plugin's content. */
const DIALOG_CHROME = 1;
const MODAL_MIN = 6;

// Accent colours are terminal palette slots, so Ghostty's theme supplies them
// and they follow its light/dark switch: 4 foam, 3 gold, 5 iris, 6 rose. The
// hex values (Peva Rose Pine) are only used when the palette is unknown.
// Text colours follow the OpenCode theme.
function ansi(index: number, fallback: string) {
  const from = (RGBA as any)?.fromIndex;
  if (typeof from === "function") {
    try {
      return from.call(RGBA, index, fallback);
    } catch {}
  }
  return fallback;
}
const ACCENT = {
  global: ansi(4, "#9ccfd8"),
  project: ansi(3, "#f6c177"),
  entity: ansi(5, "#c4a7e7"),
  relation: ansi(6, "#ebbcba"),
};
const palette = (ctx: { theme: any }) => ({
  ...ACCENT,
  muted: ctx.theme.text.muted,
  text: ctx.theme.text.base,
});

const fmt = (c: Counts) => (c ? `${c.e}e ${c.o}o ${c.r}r` : "");

type Entity = { name: string; type: string; observations: string[] };
type Relation = { from: string; to: string; type: string };
type Graph = { entities: Entity[]; relations: Relation[] } | undefined;

function load(file: string | undefined): Graph {
  if (!file || !existsSync(file)) return undefined;
  const graph = { entities: [] as Entity[], relations: [] as Relation[] };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "entity") {
        graph.entities.push({ name: row.name, type: row.entityType, observations: row.observations ?? [] });
      } else if (row.type === "relation") {
        graph.relations.push({ from: row.from, to: row.to, type: row.relationType });
      }
    } catch {}
  }
  return graph;
}

export default Plugin.define({
  id: "memory-ticker.tui",
  async setup(context) {
    try {
      const location = context.location ?? context.data.location.default();
      const reply = (await context.client.rpc(MemoryConfig).globalDir({}, { location })) as { path: string };
      GLOBAL_DIR = reply.path;
    } catch (error) {
      console.error("[memory-ticker] could not read global path from server:", (error as Error).message);
      GLOBAL_DIR = resolveGlobalDir(context.options);
    }
    const [state, update] = context.storage.memory("memory-ticker", {
      initial: { g: "…", p: "…" },
    });

    const currentProject = () => {
      const dir = projectDir(context.location?.directory ?? context.data.location.default()?.directory);
      return dir ? join(dir, FILE) : undefined;
    };

    const refresh = () => {
      const dir = projectDir(context.location?.directory ?? context.data.location.default()?.directory);
      const g = fmt(count(join(GLOBAL_DIR, FILE)));
      const p = fmt(dir ? count(join(dir, FILE)) : undefined);
      if (g !== state.g || p !== state.p) {
        update((draft) => {
          draft.g = g;
          draft.p = p;
        });
      }
    };

    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const dirs = [GLOBAL_DIR, projectDir(context.location?.directory)].filter((d): d is string => !!d);
    for (const dir of dirs) {
      try {
        watchers.push(watch(dir, schedule));
      } catch {}
    }
    // Catches stores created after startup (no directory to watch yet).
    const poll = setInterval(refresh, 5000);
    refresh();

    const open = (title: string, icon: string, kind: "global" | "project", file: string | undefined) => {
      const graph = load(file);
      const obsCount = graph?.entities.reduce((n, e) => n + e.observations.length, 0) ?? 0;
      context.ui.dialog.show(() => {
        const ctx = usePlugin();
        const pal = () => palette(ctx);
        const dims = useTerminalDimensions();
        // Shrink to keep MODAL_MARGIN rows free above and below the dialog's background.
        const height = () => Math.max(MODAL_MIN, Math.min(26, dims().height - 2 * MODAL_MARGIN - DIALOG_CHROME));
        type Scroll = {
          scrollBy(delta: number, unit?: "viewport"): void;
          scrollTo(position: number): void;
          scrollHeight: number;
        };
        let scroll: Scroll | undefined;
        // Vim motions only. The scrollbox is left unfocused so its built-in
        // arrow/page/home/end keys stay inactive; the wheel still scrolls.
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            { bind: "j", run: () => scroll?.scrollBy(1) },
            { bind: "k", run: () => scroll?.scrollBy(-1) },
            { bind: "down", run: () => scroll?.scrollBy(1) },
            { bind: "up", run: () => scroll?.scrollBy(-1) },
            { bind: "ctrl+d", run: () => scroll?.scrollBy(0.5, "viewport") },
            { bind: "ctrl+u", run: () => scroll?.scrollBy(-0.5, "viewport") },
            { bind: "g", run: () => scroll?.scrollTo(0) },
            { bind: "shift+g", run: () => scroll?.scrollTo(scroll!.scrollHeight) },
            { bind: "home", run: () => scroll?.scrollTo(0) },
            { bind: "end", run: () => scroll?.scrollTo(scroll!.scrollHeight) },
          ],
        }));
        return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} height={height()}>
          <box flexDirection="row" flexShrink={0} gap={1}>
            <text fg={pal()[kind]} attributes={TextAttributes.BOLD}>{`${icon} ${title} memory`}</text>
            <text fg={pal().muted}>
              {graph
                ? `${graph.entities.length} entities · ${obsCount} observations · ${graph.relations.length} relations`
                : "no memory file"}
            </text>
          </box>
          <box height={1} flexShrink={0} border={["top"]} borderColor={pal().muted} />
          <scrollbox ref={(el: any) => (scroll = el)} flexGrow={1} flexBasis={0} minHeight={0}>
            {graph?.entities.map((e) => (
              <box flexDirection="column" flexShrink={0} marginBottom={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={pal().entity} attributes={TextAttributes.BOLD}>{`◆ ${e.name}`}</text>
                  <text fg={pal().muted}>{`[${e.type}]`}</text>
                </box>
                {e.observations.map((o) => (
                  <box flexDirection="row" paddingLeft={2} flexShrink={0}>
                    <text fg={pal()[kind]} flexShrink={0}>{"› "}</text>
                    <text fg={pal().text}>{o}</text>
                  </box>
                ))}
              </box>
            ))}
            {graph && graph.relations.length > 0 && (
              <box flexDirection="column" flexShrink={0}>
                <text fg={pal().relation} attributes={TextAttributes.BOLD}>{"⇄ Relations"}</text>
                {graph.relations.map((r) => (
                  <box flexDirection="row" paddingLeft={2} flexShrink={0}>
                    <text fg={pal().entity}>{r.from}</text>
                    <text fg={pal().muted}>{" ──"}</text>
                    <text fg={pal().relation}>{` ${r.type} `}</text>
                    <text fg={pal().muted}>{"──▶ "}</text>
                    <text fg={pal().entity}>{r.to}</text>
                  </box>
                ))}
              </box>
            )}
            {!graph && <text fg={pal().muted}>No memory file found.</text>}
            {graph && graph.entities.length === 0 && <text fg={pal().muted}>Empty.</text>}
          </scrollbox>
          <text fg={pal().muted} flexShrink={0}>{"esc close · j/k line · ctrl+d/u half page · g/G top/bottom"}</text>
        </box>
        );
      });
      context.ui.dialog.set({ size: "xlarge", centered: true });
    };

    const openGlobal = () => open("Global", ICON.globe, "global", join(GLOBAL_DIR, FILE));
    const openProject = () => open("Project", ICON.folder, "project", currentProject());

    // `bind` is the default; override it in cli.json under keybinds by command id.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "memory-ticker.project",
          title: "Show project memory",
          group: "Memory",
          bind: "<leader>k",
          palette: true,
          slash: { name: "memory" },
          run: openProject,
        },
        {
          id: "memory-ticker.global",
          title: "Show global memory",
          group: "Memory",
          bind: "<leader>shift+k",
          palette: true,
          slash: { name: "memory-global" },
          run: openGlobal,
        },
      ],
      // Activates the bindings configured for these ids (cli.json overrides `bind`).
      bindings: ["memory-ticker.project", "memory-ticker.global"],
    }));

    const Ticker = (props: { compact?: boolean }) => {
      const ctx = usePlugin();
      const dims = useTerminalDimensions();
      const pal = () => palette(ctx);
      const hasProject = () => state.p !== "";
      const forced = () => props.compact === true || dims().width < COMPACT_BELOW;

      // Cells needed for the full widget (icon + " counts" per segment + gap) vs icons only.
      const label = (text: string) => text || "None";
      const seg = (counts: string) => 1 + 1 + label(counts).length;
      const fullWidth = () => seg(state.g) + 2 + seg(state.p);
      // Nerd Font glyphs can render two cells wide, so leave slack for two icons plus a gap.
      const iconsWidth = 2 + 1 + 2;

      // The box may shrink below fullWidth like other footer items do. When the
      // host leaves it less room than it needs, fall back to icons only; when
      // the room comes back, the measured width grows again and counts return.
      const [laidOut, setLaidOut] = createSignal(Number.POSITIVE_INFINITY);
      let box: { width: number } | undefined;
      const squeezed = () => !forced() && laidOut() < fullWidth();
      const compact = () => forced() || squeezed();
      const counts = (text: string) => (compact() ? "" : ` ${label(text)}`);

      return (
        <box
          ref={(el: { width: number }) => (box = el)}
          onSizeChange={() => box && setLaidOut(box.width)}
          flexDirection="row"
          flexShrink={forced() ? 0 : 1}
          overflow={forced() ? "visible" : "hidden"}
          gap={compact() ? 1 : 2}
          width={forced() ? undefined : fullWidth()}
          minWidth={forced() ? undefined : iconsWidth}
        >
          <box flexDirection="row" flexShrink={0} onMouseUp={openGlobal}>
            <text fg={pal().global}>{ICON.globe}</text>
            <text fg={pal().muted}>{counts(state.g)}</text>
          </box>
          <box flexDirection="row" flexShrink={0} onMouseUp={openProject}>
            <text fg={pal().project}>{hasProject() ? ICON.folder : ICON.folderOpen}</text>
            <text fg={pal().muted}>{counts(state.p)}</text>
          </box>
        </box>
      );
    };
    const stopHome = context.ui.slot({ append: "home.footer.status", render: () => <Ticker /> });
    // The prompt footer also appears under the big input on the home screen,
    // where home.footer already shows the widget, so only render it in sessions.
    const stopPrompt = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) =>
        context.ui.router.current()?.type === "session" ? (
          <Ticker compact={input.mode === "shell"} />
        ) : null,
    });

    return () => {
      clearInterval(poll);
      clearTimeout(timer);
      watchers.forEach((w) => w.close());
      stopHome?.();
      stopPrompt?.();
    };
  },
});
