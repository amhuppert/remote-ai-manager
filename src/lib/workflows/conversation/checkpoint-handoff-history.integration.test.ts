import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { compactionConfigSchema } from "@/lib/config/schemas";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { createCompactionService } from "@/lib/context-artifacts/service";
import { createCheckpointForkService } from "@/lib/conversation-checkpoints/fork-service";
import { checkpointForkFraming } from "@/lib/conversation-checkpoints/fork-framing";
import { NO_OP_SNAPSHOT_FIXTURE } from "@/lib/conversations/testing/profile-snapshot-fixtures";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import type { CheckpointPayload } from "@/lib/conversation-checkpoints/schemas";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  capturedHandoffResult,
  CHECKPOINT_TRANSCRIPT,
  createCheckpointHarness,
} from "./testing/checkpoint-harness";

describe.each(["session", "project"] as const)(
  "frozen handoff history (%s)",
  (scope) => {
    it.each(["included", "omitted"] as const)(
      "preserves %s bytes and provenance through refresh, later capture and restart",
      async (outcome) => {
        let captureCount = 0;
        const frozen = new Map<string, CheckpointPayload>();
        const h = await createCheckpointHarness({
          scope,
          workingStateObjectiveText:
            outcome === "omitted" ? "E".repeat(16000) : undefined,
          captureHandoff: async () => {
            captureCount += 1;
            return {
              ...capturedHandoffResult((await h.readRow()).backendRef),
              candidateText: JSON.stringify({
                plan: Array.from({ length: 3 }, () => ({
                  kind: "belief",
                  text: `CAPTURE_${captureCount}: agent claims approval ${"H".repeat(1420)}`,
                  sourceRefs: [],
                })),
                hypotheses: [],
                failedApproaches: [],
                blockers: [],
                nextStep: [],
              }),
            };
          },
          repo: (repo) => ({
            ...repo,
            async freezePayload(input) {
              expect((await h.readRow()).backendRef).not.toBeNull();
              expect(
                (await repo.getOperation(input.key, input.operationId))?.phase,
              ).toBe("building");
              const result = await repo.freezePayload(input);
              if (!result.ok) throw new Error(result.refusal.reason);
              const payload = await repo.getPayload(
                input.key,
                input.operationId,
              );
              const operation = await repo.getOperation(
                input.key,
                input.operationId,
              );
              expect(operation).toMatchObject({
                phase: "retiring",
                handoff: {
                  stage: outcome,
                  omissionReason: outcome === "omitted" ? "seed_budget" : null,
                  candidate: null,
                  auditDurable: true,
                },
              });
              expect(payload).toEqual(input.payload);
              expect(payload?.sourceBasis).toEqual(
                operation?.handoff?.finalSourceBasis,
              );
              expect((await h.readRow()).backendRef).not.toBeNull();
              frozen.set(input.operationId, input.payload);
              return result;
            },
          }),
        });
        try {
          const first = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          const ready = await first.completion;
          expect(ready.phase).toBe("ready");
          const firstPayload = frozen.get(ready.id);
          if (!firstPayload) throw new Error("first payload was not frozen");
          const firstProvenance = ready.handoff;
          expect(firstProvenance?.sourceCoverage).not.toBeNull();
          expect(firstPayload.seedText.includes("CAPTURE_1:")).toBe(
            outcome === "included",
          );

          const workingState = firstPayload.sections.workingState;
          if (
            !workingState ||
            typeof workingState !== "object" ||
            Array.isArray(workingState)
          ) {
            throw new Error("working state is not an object");
          }
          const { agentHandoff, ...recordedEvidence } = workingState;
          expect(JSON.stringify(recordedEvidence)).not.toContain(
            "agent claims approval",
          );
          expect(
            JSON.stringify(firstPayload.sections.recentDialogue),
          ).not.toContain("CAPTURE_1:");
          if (outcome === "included") {
            expect(agentHandoff).toMatchObject({
              attribution: expect.stringContaining(ready.id),
              caveat: expect.stringContaining(
                "do not establish current approval",
              ),
            });
          } else {
            expect(agentHandoff).toBeUndefined();
          }

          const artifacts = createContextArtifactsRepo(
            h.fixture.persistence.db,
          );
          const service = createCompactionService({
            executeTaskRun: h.fixture.executeWorkflowTaskRun,
            readEntries: async () => {
              const entries =
                h.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT) ?? [];
              return { entries, maxSeq: entries.at(-1)?.seq ?? -1 };
            },
            repo: artifacts,
            resolveConfig: async () => compactionConfigSchema.parse({}),
            broadcast() {},
            now: () => new Date().toISOString(),
          });
          for (const force of [false, true]) {
            const artifact = await service.trigger({
              kind: "conversation_compaction",
              scope,
              projectPath: h.scopeKey.projectPath,
              projectName: h.fixture.projectName,
              sessionName: scope === "session" ? h.scopeKey.sessionName : null,
              conversationId: h.scopeKey.conversationId,
              transcriptPath: CHECKPOINT_TRANSCRIPT,
              createdBy: "user",
              trigger: "frozen-handoff-regression",
              force,
            });
            if (artifact.outcome !== "started")
              throw new Error(`artifact ${artifact.outcome}`);
            const complete = await artifact.completion;
            expect(complete.status).toBe("complete");
            expect(JSON.stringify(complete.payload)).not.toContain(
              "CAPTURE_1:",
            );
            expect(
              await h.fixture.checkpoints.getPayload(h.scopeKey, ready.id),
            ).toEqual(firstPayload);
            expect((await h.operation(ready.id))?.handoff).toEqual(
              firstProvenance,
            );
          }

          await h.runOrdinaryTurn("continue the original work");
          expect(h.state.dispatches.at(-1)).toBe(
            `${firstPayload.seedText}\n\ncontinue the original work`,
          );
          const later = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          const laterReady = await later.completion;
          expect(laterReady.phase).toBe("ready");
          expect(captureCount).toBe(2);
          expect(laterReady.handoff?.captureId).not.toBe(
            firstProvenance?.captureId,
          );
          expect(laterReady.handoff?.contentHash).not.toBe(
            firstProvenance?.contentHash,
          );
          expect(laterReady.sourceBasis.capturedThroughSeq).toBeGreaterThan(
            firstPayload.sourceBasis.capturedThroughSeq,
          );
          expect(frozen.get(laterReady.id)?.seedText).not.toContain(
            "CAPTURE_1:",
          );

          h.fixture.restart();
          const reader = createConversationCheckpointsRepo(
            h.fixture.persistence.db,
            createWriteQueue(),
            h.fixture.persistence.recreateStore().checkpointContinuation,
          );
          expect(await reader.getPayload(h.scopeKey, ready.id)).toEqual(
            firstPayload,
          );
          expect(
            (await reader.getOperation(h.scopeKey, ready.id))?.handoff,
          ).toEqual(firstProvenance);
          await h.nudge();
          expect(await reader.getPayload(h.scopeKey, ready.id)).toEqual(
            firstPayload,
          );
          expect(
            (await reader.getOperation(h.scopeKey, ready.id))?.handoff,
          ).toEqual(firstProvenance);
          expect(captureCount).toBe(2);

          const forks = createCheckpointForkService({
            repo: () => reader,
            load: async (_path, target) =>
              h.fixture.persistence
                .recreateStore()
                .checkpointContinuation.find({
                  ...h.scopeKey,
                  conversationId: target.conversationId,
                }),
            admit: async (_path, _backend, selection) => selection,
            resolveWork: async () => {},
            profile: async () => NO_OP_SNAPSHOT_FIXTURE,
            publish() {},
            now: () => new Date().toISOString(),
          });
          for (const backend of ["claude", "codex"] as const) {
            const modelSelection = {
              modelId: backend === "claude" ? "claude-opus-5" : "gpt-6-astra",
              parameters: {},
            };
            const created = await forks.create({
              projectPath: h.scopeKey.projectPath,
              source: h.fixture.binding.address.target,
              operationId: ready.id,
              request: {
                requestId: randomUUID(),
                name: `Historical ${outcome} handoff`,
                task: "inspect the original evidence",
                relatedWork: { kind: "ticket", ticketNumber: 132 },
                backend,
                modelSelection,
              },
            });
            const destinationKey = {
              ...h.scopeKey,
              conversationId: created.conversation.id,
            };
            const destinationPayload = await reader.getPayload(
              destinationKey,
              created.operation.id,
            );
            expect(destinationPayload).toEqual({
              ...firstPayload,
              id: created.operation.id,
            });
            const origin = created.conversation.checkpointFork;
            if (!origin) throw new Error("missing fork lineage");
            expect(origin).toMatchObject({
              sourceOperationId: ready.id,
              evidenceSource: h.fixture.binding.address.target,
              seedSha256: firstPayload.seedSha256,
            });
            const admission = await h.fixture.manager.submitConversationTurn({
              binding: {
                kind: "durable",
                address: {
                  ...h.fixture.binding.address,
                  target: {
                    ...h.fixture.binding.address.target,
                    conversationId: created.conversation.id,
                  },
                },
              },
              turn: {
                promptText: "inspect the original evidence",
                backend,
                modelSelection,
              },
            });
            if (admission.kind !== "accepted")
              throw new Error(admission.message);
            await admission.turn.completed;
            expect(h.latestRuntime().ref.backend).toBe(backend);
            expect(h.latestRuntime().input.persistedRef).toBeNull();
            expect(h.state.dispatches.at(-1)).toBe(
              `${checkpointForkFraming(created.conversation.id, origin)}${firstPayload.seedText}\n\ninspect the original evidence`,
            );
            expect(
              await reader.getOperation(destinationKey, created.operation.id),
            ).toMatchObject({
              phase: "applied",
              acceptance: { seedHash: firstPayload.seedSha256 },
            });
            expect(await reader.getPayload(h.scopeKey, ready.id)).toEqual(
              firstPayload,
            );
            expect(
              (await reader.getOperation(h.scopeKey, ready.id))?.handoff,
            ).toEqual(firstProvenance);
            expect(captureCount).toBe(2);
            await h.fixture.manager.stopConversationActor(
              h.fixture.identity.projectPath,
              h.fixture.identity.sessionName,
              created.conversation.id,
              "fixture_cleanup",
            );
          }
        } finally {
          await h.close();
        }
      },
    );
  },
);
