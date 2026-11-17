import { Rpc } from "@opencode/plugin/rpc";

const object = { type: "object" } as const;

/**
 * The TUI part has no access to the server's plugin options or hooks, so it
 * reads and changes everything through these methods and refreshes on
 * `changed`.
 */
export const AutoMode = Rpc.define({
  id: "auto-mode",
  methods: {
    state: { input: object, output: object },
    setGlobal: { input: object, output: object },
    setSetting: { input: object, output: object },
    setOverride: { input: object, output: object },
  },
  events: {
    changed: { schema: object },
  },
});
