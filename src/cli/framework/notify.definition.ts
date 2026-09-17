import { ccCommands } from "./family";

export const notifySpec = {
  path: "notify",
  summary: "Send a push notification to the user",
  description:
    "Send one message through the addressed session or project conversation.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "message",
      description: "Notification message",
      value: { kind: "string" },
    },
  ],
  flags: {
    title: { description: "Notification title", value: { kind: "string" } },
  },
} as const;

export const notifyCommand = ccCommands.defineCommand(notifySpec, {
  examples: [
    {
      args: { message: "Build finished" },
      why: "Report completion of a long task",
    },
  ],
  handler: async () => ({
    default: (await import("./notify.handler")).default,
  }),
});
