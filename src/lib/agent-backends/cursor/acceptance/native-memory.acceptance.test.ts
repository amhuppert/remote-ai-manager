import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  agentSessionRefSchema,
  type AgentSessionRef,
} from "@/lib/shared/schemas";
import type { ConversationBackendEvent } from "../../conversation";
import { CursorConversationRuntime } from "../conversation-runtime";
import { createCursorTaskRunner } from "../task-runner";
import { translatePortableMcpToCursor } from "../mcp-translation";
import { resolveAcceptanceEvidenceRoot } from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
} from "./live-worker";

// File receipts prove consumption of CC-provided memory, not provider-memory
// neutralization. The SDK exposes neither a disable lever nor effective state.
it.each(["conversation", "task"] as const)(
  "%s consumes CC memory on create and durable resume with instruction-only policy",
  async (kind) => {
    const root = resolveAcceptanceEvidenceRoot(process.env);
    const { secret, store } = await openAcceptanceEvidence(process.env);
    const harness = createLiveHarness({
      credential: secret.value,
      evidenceRoot: root,
    });
    const workspace = harness.createWorkspace(`memory-${kind}-${randomUUID()}`);
    const conversationId = randomUUID();
    const deps = {
      transport: harness.transport,
      storePath: () => workspace.storePath,
      resolveModel: async (
        selection: typeof CURSOR_ACCEPTANCE_MODEL_SELECTION,
      ) => ({ ok: true as const, selection }),
      translatePortableMcpToCursor,
      newRunId: randomUUID,
      now: Date.now,
      stallTimeoutMs: 90_000,
      cancelSettleTimeoutMs: 10_000,
    };
    const runner = createCursorTaskRunner(deps);
    const events: ConversationBackendEvent[] = [];
    const receipts: { phase: string; token: string; ref: AgentSessionRef }[] =
      [];
    let ref: AgentSessionRef | null = null;
    try {
      for (const phase of ["create", "resume"]) {
        const token = `CC-NOTE-${randomUUID()}`;
        const receipt = path.join(workspace.cwd, `${phase}.txt`);
        const prompt = `<memory-index>\n- receipt-token: The current receipt token is ${token}.\n</memory-index>\nRead the current receipt-token from the supplied CC memory index. Write only its value to ${receipt} using a file tool, replacing any earlier token. Then reply DONE. Do not change other files.`;
        let nextRef: AgentSessionRef | null;
        if (kind === "task") {
          const result = await runner.run({
            executionClass: "governed-execution",
            workingDirectory: workspace.cwd,
            modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
            prompt,
            timeoutMs: 120_000,
            autonomous: true,
            ...(ref === null ? {} : { resumeRef: ref }),
          });
          expect(result.error).toBeNull();
          nextRef = result.backendRef ?? null;
        } else {
          const runtime = new CursorConversationRuntime(
            {
              executionClass: "governed-execution",
              conversationId,
              projectPath: workspace.cwd,
              projectName: "cursor-acceptance",
              conversationTarget: {
                scope: "project",
                projectName: "cursor-acceptance",
                conversationId,
              },
              worktreePath: workspace.cwd,
              persistedRef: ref,
              modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
              sessionInstructions: [],
              tooling: {},
            },
            deps,
          );
          try {
            const result = await runtime.sendTurn({
              promptText: prompt,
              imageRefs: [],
              sessionInstructions: [],
              modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
              autonomous: true,
              signal: AbortSignal.timeout(120_000),
              onEvent: (event) => {
                events.push(event);
              },
            });
            expect(result.failure).toBeNull();
            nextRef = result.backendRef ?? null;
          } finally {
            await runtime.close();
          }
        }
        expect((await readFile(receipt, "utf8")).trim()).toBe(token);
        const parsed = agentSessionRefSchema.parse(nextRef);
        if (ref !== null) expect(parsed).toEqual(ref);
        const refFile = path.join(workspace.storePath, "cc-memory-ref.json");
        await writeFile(refFile, JSON.stringify(parsed), { mode: 0o600 });
        ref = agentSessionRefSchema.parse(
          JSON.parse(await readFile(refFile, "utf8")),
        );
        receipts.push({ phase, token, ref });
      }
      const artifact = await store.writeRaw(
        `native-memory-${kind}-${conversationId}.json`,
        JSON.stringify({ receipts, events }),
      );
      await store.publish({
        caseId: `native-memory-${kind}-fallback`,
        outcome: "pass",
        metrics: {
          turns: 2,
          durableResume: true,
          ccMemoryConsumed: true,
          nativeMemoryNeutralized: false,
          effectiveNativeMemoryState: "unknown",
        },
        artifacts: [artifact],
      });
    } finally {
      await harness.closeAll();
    }
  },
  300_000,
);
