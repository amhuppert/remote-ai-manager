import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { readPromptDispatches } from "./prompt-evidence";

describe("prompt dispatch evidence", () => {
  it("reads all recorded phases at their actual raw coordinates without replaying them as messages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-prompt-evidence-"));
    const transcriptPath = path.join(directory, "transcript.jsonl");
    const timestamp = "2026-10-15T23:00:00.000Z";
    const work = {
      phase: "work",
      promptText: "Work first.\u2028Keep this within the same record.\u2029",
      outputSchema: null,
      userPromptText: "Work first.",
      promptContext: null,
    };
    const format = {
      ...work,
      phase: "format",
      promptText: "Return the result as JSON.",
      outputSchema: { type: "object" },
      userPromptText: "",
    };
    try {
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            role: "user",
            timestamp,
            content: [{ type: "text", text: "Work first." }],
          }),
          "",
          JSON.stringify({
            type: "prompt_dispatch",
            timestamp,
            promptDispatch: work,
          }),
          "partial malformed line",
          JSON.stringify({
            type: "prompt_dispatch",
            timestamp,
            promptDispatch: format,
          }),
          JSON.stringify({
            type: "assistant",
            role: "assistant",
            timestamp,
            content: [{ type: "text", text: "Done." }],
          }),
        ].join("\n"),
      );

      expect(await readPromptDispatches(transcriptPath)).toEqual([
        { ...work, seq: 2, timestamp },
        { ...format, seq: 4, timestamp },
      ]);
      const replay = await readConversationMessagesWithSeq(transcriptPath);
      expect(replay.map((message) => message.content)).toEqual([
        [{ type: "text", text: "Work first." }],
        [{ type: "text", text: "Done." }],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
