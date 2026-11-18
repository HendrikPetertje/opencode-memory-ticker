import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntity, addObservation, addRelation, edit, parseRelation, readLines, remove, writeLines } from "./memory.ts";

const sample = [
  '{"type":"_aim","source":"mcp-knowledge-graph"}',
  '{"type":"entity","name":"peter","entityType":"person","observations":["likes TypeScript","uses vim"]}',
  '{"type":"entity","name":"opencode","entityType":"project","observations":[]}',
  '{"type":"relation","from":"peter","to":"opencode","relationType":"develops"}',
  "",
].join("\n");

const file = () => {
  const path = join(mkdtempSync(join(tmpdir(), "mem-")), "memory-current.jsonl");
  writeFileSync(path, sample);
  return path;
};

describe("memory file edits", () => {
  test("round trip keeps unknown lines", () => {
    const path = file();
    writeLines(path, readLines(path));
    expect(readFileSync(path, "utf8")).toBe(sample);
  });

  test("the _aim marker stays first, and a foreign file is never written", () => {
    const path = file();
    writeLines(path, []);
    expect(readFileSync(path, "utf8")).toBe('{"type":"_aim","source":"mcp-knowledge-graph"}\n');
    expect(() => writeLines(path, [{ type: "entity", name: "x" }])).toThrow();
  });

  test("remove an observation, an entity (with its relations) and a relation", () => {
    const lines = readLines(file());
    remove(lines, { kind: "observation", name: "peter", index: 0 });
    expect(lines[1]!.observations).toEqual(["uses vim"]);
    expect(remove(readLines(file()), { kind: "entity", name: "opencode" }).some((l) => l.type === "relation")).toBe(false);
    expect(remove(readLines(file()), { kind: "relation", from: "peter", to: "opencode", relationType: "develops" })).toHaveLength(3);
  });

  test("edit an observation, rename an entity, rewrite a relation", () => {
    const lines = readLines(file());
    edit(lines, { kind: "observation", name: "peter", index: 1 }, "uses neovim");
    expect(lines[1]!.observations[1]).toBe("uses neovim");
    edit(lines, { kind: "entity", name: "peter" }, "peva");
    expect(lines[3]).toMatchObject({ from: "peva" });
    expect(() => edit(lines, { kind: "entity", name: "peva" }, "opencode")).toThrow();
    edit(lines, { kind: "relation", from: "peva", to: "opencode", relationType: "develops" }, { from: "peva", to: "opencode", relationType: "uses" });
    expect(lines[3]).toMatchObject({ relationType: "uses" });
  });

  test("add an observation, an entity before the relations, and a relation once", () => {
    const lines = readLines(file());
    addObservation(lines, "opencode", "V2 only");
    expect(lines[2]!.observations).toEqual(["V2 only"]);
    addEntity(lines, "bun", "tool");
    expect(lines[3]).toMatchObject({ type: "entity", name: "bun" });
    addRelation(lines, { from: "opencode", to: "bun", relationType: "uses" });
    addRelation(lines, { from: "opencode", to: "bun", relationType: "uses" });
    expect(lines.filter((l) => l.type === "relation")).toHaveLength(2);
  });

  test("parse relations", () => {
    expect(parseRelation("peter --develops--> opencode")).toEqual({ from: "peter", relationType: "develops", to: "opencode" });
    expect(parseRelation("peter -works on-> my project")).toEqual({ from: "peter", relationType: "works on", to: "my project" });
    expect(parseRelation("peter develops opencode")).toEqual({ from: "peter", relationType: "develops", to: "opencode" });
    expect(parseRelation("nonsense")).toBeUndefined();
  });
});
