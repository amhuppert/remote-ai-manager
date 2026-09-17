import { bytes } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

export const askSpec = {
  path: "ask",
  summary: "Ask the user a batch of questions",
  description:
    "Register questions on this conversation. End the turn after registration; answers arrive in the next user message. The file contains a nonempty questions array with question text and options.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(256 * 1024), validatePath: "ask-check" },
} as const;

export const askCommand = ccCommands.defineCommand(askSpec, {
  examples: [
    {
      file: ".cc/temp/questions.json",
      why: "Ask a consequential question before continuing",
    },
  ],
  handler: async () => ({ default: (await import("./handler")).default }),
});
export const askCommands = [askCommand] as const;
