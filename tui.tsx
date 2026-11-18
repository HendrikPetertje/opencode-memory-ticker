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
import {
  addEntity,
  addObservation,
  addRelation,
  edit as editLine,
  formatRelation,
  parseRelation,
  readLines,
  remove as removeLine,
  writeLines,
  type Line,
  type Target,
} from "./memory.ts";
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
  /** Background of the selected row. */
  surface: ansi(0, "#26233a"),
};
/** `dd`: two presses within this window. */
const DOUBLE_TAP_MS = 600;
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

    type Row =
      | { kind: "entity"; entity: Entity }
      | { kind: "observation"; entity: Entity; index: number; text: string }
      | { kind: "relations" }
      | { kind: "relation"; relation: Relation };

    const rowsOf = (graph: Graph): Row[] => {
      const rows: Row[] = [];
      for (const entity of graph?.entities ?? []) {
        rows.push({ kind: "entity", entity });
        entity.observations.forEach((text, index) => rows.push({ kind: "observation", entity, index, text }));
      }
      if (graph) rows.push({ kind: "relations" });
      for (const relation of graph?.relations ?? []) rows.push({ kind: "relation", relation });
      return rows;
    };

    const targetOf = (row: Row | undefined): Target | undefined => {
      if (row?.kind === "entity") return { kind: "entity", name: row.entity.name };
      if (row?.kind === "observation") return { kind: "observation", name: row.entity.name, index: row.index };
      if (row?.kind === "relation") return { kind: "relation", from: row.relation.from, to: row.relation.to, relationType: row.relation.type };
      return undefined;
    };

    const open = (title: string, icon: string, kind: "global" | "project", file: string | undefined, start = 0) => {
      const reopen = (at: number) => open(title, icon, kind, file, at);
      /** Runs a change on the file, reports problems, and reopens the dialog on `at`. */
      const change = (at: number, mutate: (lines: Line[]) => Line[]) => {
        try {
          if (!file || !existsSync(file)) throw new Error("no memory file yet; let the agent store something first");
          writeLines(file, mutate(readLines(file)));
          refresh();
        } catch (error) {
          context.ui.toast.show({ variant: "error", title: "Memory", message: (error as Error).message ?? String(error) });
        }
        reopen(at);
      };
      const ask = (options: { title: string; description?: string; placeholder?: string; value?: string }) =>
        context.ui.dialog.prompt(options).then((value) => value?.trim() || undefined);

      context.ui.dialog.show(() => {
        const ctx = usePlugin();
        const pal = () => palette(ctx);
        const dims = useTerminalDimensions();
        // Shrink to keep MODAL_MARGIN rows free above and below the dialog's background.
        const height = () => Math.max(MODAL_MIN, Math.min(26, dims().height - 2 * MODAL_MARGIN - DIALOG_CHROME));
        const graph = load(file);
        const rows = rowsOf(graph);
        const obsCount = graph?.entities.reduce((n, e) => n + e.observations.length, 0) ?? 0;
        const [selected, setSelected] = createSignal(Math.max(0, Math.min(start, rows.length - 1)));
        let scroll: { scrollTo(position: number): void } | undefined;
        let pendingD = 0;
        const move = (delta: number) => {
          const next = Math.max(0, Math.min(rows.length - 1, selected() + delta));
          setSelected(next);
          scroll?.scrollTo(Math.max(0, next - Math.floor(height() / 3)));
        };
        queueMicrotask(() => move(0));
        const current = () => rows[selected()];

        const remove = async () => {
          const row = current();
          const target = targetOf(row);
          if (!target || row?.kind === "relations") return;
          if (row?.kind === "entity") {
            const ok = await context.ui.dialog.confirm({
              title: `Delete ${row.entity.name}?`,
              message: `Removes the entity, its ${row.entity.observations.length} observations and its relations.`,
            });
            if (!ok) return reopen(selected());
          }
          change(selected(), (lines) => removeLine(lines, target));
        };

        const edit = async () => {
          const row = current();
          const at = selected();
          if (row?.kind === "observation") {
            const value = await ask({ title: `Edit observation of ${row.entity.name}`, value: row.text });
            return value ? change(at, (lines) => editLine(lines, targetOf(row)!, value)) : reopen(at);
          }
          if (row?.kind === "entity") {
            const value = await ask({ title: "Rename entity", description: "Its relations follow the new name.", value: row.entity.name });
            return value ? change(at, (lines) => editLine(lines, targetOf(row)!, value)) : reopen(at);
          }
          if (row?.kind === "relation") {
            const value = await ask({ title: "Edit relation", description: "from --type--> to", value: formatRelation({ ...row.relation, relationType: row.relation.type }) });
            const relation = value ? parseRelation(value) : undefined;
            if (value && !relation) context.ui.toast.show({ variant: "error", title: "Memory", message: "Write it as: from --type--> to" });
            return relation ? change(at, (lines) => editLine(lines, targetOf(row)!, relation)) : reopen(at);
          }
        };

        /** On an entity or observation: a new observation. On relations: a new relation. Elsewhere: a new entity. */
        const add = async () => {
          const row = current();
          const at = selected();
          if (row?.kind === "entity" || row?.kind === "observation") {
            const value = await ask({ title: `New observation for ${row.entity.name}` });
            const end = rows.findIndex((r) => r.kind === "entity" && r.entity === row.entity) + row.entity.observations.length + 1;
            return value ? change(end, (lines) => addObservation(lines, row.entity.name, value)) : reopen(at);
          }
          if (row?.kind === "relations" || row?.kind === "relation") {
            const value = await ask({ title: "New relation", description: "from --type--> to", placeholder: "peter --develops--> opencode" });
            const relation = value ? parseRelation(value) : undefined;
            if (value && !relation) context.ui.toast.show({ variant: "error", title: "Memory", message: "Write it as: from --type--> to" });
            return relation ? change(rows.length, (lines) => addRelation(lines, relation)) : reopen(at);
          }
          return addNewEntity();
        };

        const addNewEntity = async () => {
          const at = selected();
          const name = await ask({ title: "New entity", placeholder: "name" });
          if (!name) return reopen(at);
          const type = await ask({ title: `Type of ${name}`, placeholder: "person, project, tool, …" });
          if (!type) return reopen(at);
          const index = rows.findIndex((r) => r.kind === "relations");
          change(index === -1 ? rows.length : index, (lines) => addEntity(lines, name, type));
        };

        // Vim motions; the scrollbox stays unfocused so only these keys move it (the wheel still scrolls).
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            { bind: "j", run: () => move(1) },
            { bind: "k", run: () => move(-1) },
            { bind: "down", run: () => move(1) },
            { bind: "up", run: () => move(-1) },
            { bind: "ctrl+d", run: () => move(10) },
            { bind: "ctrl+u", run: () => move(-10) },
            { bind: "g", run: () => move(-100000) },
            { bind: "shift+g", run: () => move(100000) },
            { bind: "home", run: () => move(-100000) },
            { bind: "end", run: () => move(100000) },
            {
              bind: "d",
              run: () => {
                const now = Date.now();
                if (now - pendingD < DOUBLE_TAP_MS) {
                  pendingD = 0;
                  void remove();
                } else pendingD = now;
              },
            },
            { bind: "e", run: () => void edit() },
            { bind: "a", run: () => void add() },
            { bind: "shift+a", run: () => void addNewEntity() },
          ],
        }));

        const marked = (index: number) => (index === selected() ? (ACCENT.surface as any) : undefined);
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
              {rows.map((row, index) => {
                if (row.kind === "entity") {
                  return (
                    <box flexDirection="row" gap={1} flexShrink={0} marginTop={index === 0 ? 0 : 1} backgroundColor={marked(index)} onMouseUp={() => setSelected(index)}>
                      <text fg={pal().entity} attributes={TextAttributes.BOLD}>{`◆ ${row.entity.name}`}</text>
                      <text fg={pal().muted}>{`[${row.entity.type}]`}</text>
                    </box>
                  );
                }
                if (row.kind === "observation") {
                  return (
                    <box flexDirection="row" paddingLeft={2} flexShrink={0} backgroundColor={marked(index)} onMouseUp={() => setSelected(index)}>
                      <text fg={pal()[kind]} flexShrink={0}>{"› "}</text>
                      <text fg={pal().text}>{row.text}</text>
                    </box>
                  );
                }
                if (row.kind === "relations") {
                  return (
                    <box flexShrink={0} marginTop={1} backgroundColor={marked(index)} onMouseUp={() => setSelected(index)}>
                      <text fg={pal().relation} attributes={TextAttributes.BOLD}>{"⇄ Relations"}</text>
                    </box>
                  );
                }
                return (
                  <box flexDirection="row" paddingLeft={2} flexShrink={0} backgroundColor={marked(index)} onMouseUp={() => setSelected(index)}>
                    <text fg={pal().entity}>{row.relation.from}</text>
                    <text fg={pal().muted}>{" ──"}</text>
                    <text fg={pal().relation}>{` ${row.relation.type} `}</text>
                    <text fg={pal().muted}>{"──▶ "}</text>
                    <text fg={pal().entity}>{row.relation.to}</text>
                  </box>
                );
              })}
              {!graph && <text fg={pal().muted}>No memory file found.</text>}
              {graph && graph.entities.length === 0 && <text fg={pal().muted}>Empty. Press shift+a to add an entity.</text>}
            </scrollbox>
            <text fg={pal().muted} flexShrink={0} wrapMode="word">
              {"esc close · j/k move · g/G top/bottom · e edit · a add · A new entity · dd delete"}
            </text>
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
