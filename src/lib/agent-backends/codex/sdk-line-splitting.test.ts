import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { afterEach, describe, expect, it } from "vitest";

// `codex exec --json` serializes command output with serde_json, which leaves
// U+2028 / U+2029 unescaped inside JSON strings (they are legal there), and
// Node 24's readline treats both as line terminators. The stock SDK splits its
// JSONL stream with readline, so one such character in a tool's output
// shattered the event and killed the turn ("Failed to parse item"). The
// dependency patch under `patches/` pins the SDK to newline-only splitting;
// these tests prove the installed SDK carries it.

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
};

function writeFakeCodex(dir: string, events: unknown[]): string {
  const eventsPath = path.join(dir, "events.jsonl");
  writeFileSync(
    eventsPath,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  // Drains the prompt the SDK writes to stdin, then replays the scripted
  // JSONL stream byte-for-byte.
  const executablePath = path.join(dir, "codex");
  writeFileSync(
    executablePath,
    `#!/bin/sh\ncat >/dev/null\ncat "${eventsPath}"\n`,
  );
  chmodSync(executablePath, 0o755);
  return executablePath;
}

describe("codex sdk JSONL line splitting", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps an event intact when a string carries U+2028 / U+2029", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cc-codex-sdk-lines-"));
    const aggregatedOutput = `first${LINE_SEPARATOR}second${PARAGRAPH_SEPARATOR}third`;
    const executablePath = writeFakeCodex(dir, [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "printf",
          aggregated_output: aggregatedOutput,
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "item-2", type: "agent_message", text: "done" },
      },
      { type: "turn.completed", usage },
    ]);

    const thread = new Codex({ codexPathOverride: executablePath }).startThread(
      {
        skipGitRepoCheck: true,
        workingDirectory: dir,
      },
    );
    const turn = await thread.run("hello");

    expect(turn.items).toContainEqual(
      expect.objectContaining({
        id: "item-1",
        aggregated_output: aggregatedOutput,
      }),
    );
    expect(turn.finalResponse).toBe("done");
    expect(thread.id).toBe("thread-1");
  });
});
