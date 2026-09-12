import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentSessionRefSchema } from "@/lib/shared/schemas";
import { createCursorTaskRunner } from "../task-runner";
import { translatePortableMcpToCursor } from "../mcp-translation";
import {
  createLiveHarness,
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
} from "./live-worker";
import { requireAcceptanceCredential } from "./harness";

const input = z
  .object({ root: z.string(), cwd: z.string(), ref: agentSessionRefSchema })
  .parse(JSON.parse(await readFile(process.argv[2] ?? "", "utf8")));
const harness = createLiveHarness({
  credential: requireAcceptanceCredential(process.env).value,
  evidenceRoot: input.root,
});
let pid: number | null = null;
const runner = createCursorTaskRunner({
  transport: {
    async start(start) {
      const result = await harness.transport.start({
        ...start,
        onFrame(frame) {
          start.onFrame(frame);
          if (frame.type === "inputAccepted")
            process.stdout.write(
              `${JSON.stringify({ accepted: true, pid })}\n`,
            );
        },
      });
      if (result.kind === "ready") pid = result.session.pid;
      return result;
    },
    find: (id) => harness.transport.find(id),
    closeAll: () => harness.closeAll(),
  },
  storePath: (id) => path.join(input.root, "task-stores", id),
  resolveModel: async (selection) => ({ ok: true, selection }),
  translatePortableMcpToCursor,
  newRunId: randomUUID,
  now: Date.now,
  stallTimeoutMs: 90_000,
  cancelSettleTimeoutMs: 10_000,
});
await runner.run({
  executionClass: "nongoverned-task",
  workingDirectory: input.cwd,
  prompt:
    "Run a shell command that waits for sixty seconds before replying WAIT_DONE.",
  resumeRef: input.ref,
  modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  timeoutMs: 120_000,
  autonomous: true,
});
await harness.closeAll();
