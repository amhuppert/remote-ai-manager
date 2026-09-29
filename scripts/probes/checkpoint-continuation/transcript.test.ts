import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readProbeAssistantTexts } from "./transcript";

it("grades the complete streamed answer after queued delivery, not its final token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "checkpoint-transcript-"));
  const file = path.join(root, "transcript.jsonl");
  const timestamp = "2026-09-29T00:00:00Z";
  const chunks = ["ledger-", "exports-v2", "\nMEMORY-WITNESS: witness"];
  try {
    await writeFile(
      file,
      [
        {
          timestamp,
          type: "user",
          role: "user",
          content: [{ type: "text", text: "Which bucket?" }],
        },
        ...chunks.map((text, index) => ({
          id: `cursor:conversation:run:${index}`,
          timestamp,
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text }],
          raw: {
            type: "assistant",
            agent_id: "agent",
            run_id: "run",
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    expect(await readProbeAssistantTexts(file)).toEqual([chunks.join("")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
