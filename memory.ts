/**
 * Edits a mcp-knowledge-graph JSONL file (`memory-current.jsonl`). Every line
 * is kept as parsed; lines that aren't entities or relations (the `_aim`
 * marker, anything newer) are written back unchanged. Writes are atomic.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export type Line = Record<string, any>;

/** First line of every mcp-knowledge-graph file. */
export const FILE_MARKER = { type: "_aim", source: "mcp-knowledge-graph" };

export function readLines(file: string): Line[] {
  const lines: Line[] = [];
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try {
      lines.push(JSON.parse(text));
    } catch {
      lines.push({ __raw: text });
    }
  }
  return lines;
}

export function writeLines(file: string, lines: Line[]): void {
  // The MCP server refuses files whose first line isn't its marker.
  const marker = lines.findIndex((line) => line.type === "_aim");
  if (marker === -1) {
    if (lines.length > 0) throw new Error("this file has no _aim marker line, so it isn't a memory file; not touching it");
    lines.unshift({ ...FILE_MARKER });
  } else if (marker > 0) {
    lines.unshift(...lines.splice(marker, 1));
  }
  const text = lines.map((line) => (typeof line.__raw === "string" ? line.__raw : JSON.stringify(line))).join("\n");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text ? `${text}\n` : "");
  renameSync(tmp, file);
}

const entity = (lines: Line[], name: string) => lines.find((line) => line.type === "entity" && line.name === name);

/** What a row in the dialog points at. */
export type Target =
  | { kind: "entity"; name: string }
  | { kind: "observation"; name: string; index: number }
  | { kind: "relation"; from: string; to: string; relationType: string };

const sameRelation = (line: Line, target: { from: string; to: string; relationType: string }) =>
  line.type === "relation" && line.from === target.from && line.to === target.to && line.relationType === target.relationType;

/** Removes the target. An entity takes its relations with it, as the MCP server's delete_entities does. */
export function remove(lines: Line[], target: Target): Line[] {
  if (target.kind === "entity") {
    return lines.filter(
      (line) => !(line.type === "entity" && line.name === target.name) && !(line.type === "relation" && (line.from === target.name || line.to === target.name)),
    );
  }
  if (target.kind === "observation") {
    const found = entity(lines, target.name);
    if (found && Array.isArray(found.observations)) found.observations.splice(target.index, 1);
    return lines;
  }
  return lines.filter((line) => !sameRelation(line, target));
}

/** Replaces an observation's text, renames an entity (and its relations), or rewrites a relation. */
export function edit(lines: Line[], target: Target, value: string | { from: string; to: string; relationType: string }): Line[] {
  if (target.kind === "observation" && typeof value === "string") {
    const found = entity(lines, target.name);
    if (found && Array.isArray(found.observations)) found.observations[target.index] = value;
  } else if (target.kind === "entity" && typeof value === "string" && value !== target.name) {
    if (entity(lines, value)) throw new Error(`an entity named "${value}" already exists`);
    for (const line of lines) {
      if (line.type === "entity" && line.name === target.name) line.name = value;
      if (line.type === "relation" && line.from === target.name) line.from = value;
      if (line.type === "relation" && line.to === target.name) line.to = value;
    }
  } else if (target.kind === "relation" && typeof value === "object") {
    const found = lines.find((line) => sameRelation(line, target));
    if (found) Object.assign(found, value);
  }
  return lines;
}

export function addObservation(lines: Line[], name: string, text: string): Line[] {
  const found = entity(lines, name);
  if (!found) throw new Error(`no entity named "${name}"`);
  found.observations = [...(Array.isArray(found.observations) ? found.observations : []), text];
  return lines;
}

export function addEntity(lines: Line[], name: string, entityType: string): Line[] {
  if (entity(lines, name)) throw new Error(`an entity named "${name}" already exists`);
  // Entities before relations, as the MCP server writes them.
  const firstRelation = lines.findIndex((line) => line.type === "relation");
  const line = { type: "entity", name, entityType, observations: [] };
  if (firstRelation === -1) lines.push(line);
  else lines.splice(firstRelation, 0, line);
  return lines;
}

export function addRelation(lines: Line[], relation: { from: string; to: string; relationType: string }): Line[] {
  if (lines.some((line) => sameRelation(line, relation))) return lines;
  lines.push({ type: "relation", ...relation });
  return lines;
}

/** `from --type--> to`, `from -type-> to` or `from type to` (single-word type). */
export function parseRelation(text: string): { from: string; to: string; relationType: string } | undefined {
  const arrow = text.match(/^\s*(.+?)\s+-+\s*(.+?)\s*-+>\s+(.+?)\s*$/);
  if (arrow) return { from: arrow[1]!, relationType: arrow[2]!, to: arrow[3]! };
  const words = text.trim().split(/\s+/);
  if (words.length === 3) return { from: words[0]!, relationType: words[1]!, to: words[2]! };
  return undefined;
}

export const formatRelation = (relation: { from: string; to: string; relationType: string }) =>
  `${relation.from} --${relation.relationType}--> ${relation.to}`;
