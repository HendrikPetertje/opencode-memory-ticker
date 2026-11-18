import { Rpc } from "@opencode/plugin/rpc";

/** Lets the TUI part ask the server part which global .aim directory it configured. */
export const MemoryConfig = Rpc.define({
  id: "memory-ticker",
  methods: {
    globalDir: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
