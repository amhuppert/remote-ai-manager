import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import type {
  CaptureHandoffInput,
  CaptureHandoffResult,
} from "@/lib/agent-backends/conversation";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  capturedHandoffResult as acceptedCapture,
  createCheckpointHarness,
  gatedGenerator,
  deferred,
  CHECKPOINT_TRANSCRIPT,
  transcriptText,
} from "./testing/checkpoint-harness";

describe.each(["session", "project"] as const)(
  "checkpoint capture admission (%s)",
  (scope) => {
    it.each(["tool-disabled", "instruction-only"] as const)(
      "discloses %s capture read-only without reserving or allocating",
      async (mode) => {
        const h = await createCheckpointHarness({
          scope,
          captureAvailability: () => ({ available: true, mode }),
        });
        try {
          const before = await h.readRow();
          const result = await h.fixture.manager.checkConversationCheckpoint(
            h.fixture.binding.address,
          );
          expect(result).toMatchObject({
            eligible: true,
            hosted: false,
            handoff: {
              available: true,
              mode,
              reason: null,
              policy: { version: "1" },
            },
          });
          expect(await h.readRow()).toEqual(before);
          expect(
            await h.fixture.checkpoints.getStateForAdmission(h.scopeKey),
          ).toMatchObject({ active: null });
          expect(h.state.created).toEqual([]);
          expect(h.state.dispatches).toEqual([]);
          expect(h.state.laneCalls).toEqual([]);
        } finally {
          await h.close();
        }
      },
    );

    it("keeps baseline eligible when capture continuity is unavailable", async () => {
      const h = await createCheckpointHarness({ scope, seededRef: null });
      try {
        expect(
          await h.fixture.manager.checkConversationCheckpoint(
            h.fixture.binding.address,
          ),
        ).toMatchObject({
          eligible: true,
          handoff: {
            available: false,
            mode: "tool-disabled",
            reason: "continuity_unavailable",
          },
        });
        expect(h.state.created).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it("discloses descriptor capture unavailability without changing baseline eligibility", async () => {
      const h = await createCheckpointHarness({
        scope,
        captureAvailability: () => ({
          available: false,
          mode: null,
          reason: "capture unsupported",
        }),
      });
      try {
        expect(
          await h.fixture.manager.checkConversationCheckpoint(
            h.fixture.binding.address,
          ),
        ).toMatchObject({
          eligible: true,
          handoff: {
            available: false,
            mode: null,
            reason: "capture unsupported",
          },
        });
        expect(h.state.created).toEqual([]);
      } finally {
        await h.close();
      }
    });
    it.each([false, true])(
      "skip holds live capture and cancel dominates (%s)",
      async (cancel) => {
        const entered = deferred<CaptureHandoffInput>();
        const finish = deferred();
        const h = await createCheckpointHarness({
          scope,
          captureHandoff: async (input) => {
            entered.resolve(input);
            await finish.promise;
            return acceptedCapture(h.seededRef);
          },
        });
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          const input = await entered.promise;
          await h.enqueue("held while capture stops");
          const before = (await h.readRow()).pendingQueue;
          const skipped =
            await h.fixture.manager.skipConversationCheckpointHandoff({
              address: h.fixture.binding.address,
              operationId: started.operation.id,
            });
          expect(skipped.kind).toBe("stopping");
          expect(input.signal.aborted).toBe(true);
          expect(
            (await h.operation(started.operation.id))?.handoff,
          ).toMatchObject({ stage: "settling", stopIntent: "skip" });
          const cancelling = cancel
            ? h.fixture.manager.cancelConversationCheckpoint({
                address: h.fixture.binding.address,
                operationId: started.operation.id,
              })
            : null;
          if (cancel)
            await vi.waitFor(async () =>
              expect(
                (await h.operation(started.operation.id))?.handoff?.stopIntent,
              ).toBe("cancel"),
            );
          await h.nudge();
          expect((await h.readRow()).pendingQueue).toEqual(before);
          expect(h.state.dispatches).toEqual([]);
          expect(h.state.laneCalls).toEqual([]);
          finish.resolve();
          const operation = await started.completion;
          if (cancelling) expect((await cancelling).kind).toBe("cancelled");
          expect(operation).toMatchObject({
            phase: cancel ? "cancelled" : "ready",
            handoff: {
              stage: "omitted",
              omissionReason: cancel ? "cancelled" : "skipped",
              candidate: null,
              executionSettled: true,
              auditDurable: true,
            },
          });
          expect(
            (
              await h.fixture.manager.skipConversationCheckpointHandoff({
                address: h.fixture.binding.address,
                operationId: operation.id,
              })
            ).kind,
          ).toBe("handoff_already_settled");
        } finally {
          finish.resolve();
          await h.close();
        }
      },
    );

    it("whole cancel racing a serialized skipped result has one terminal outcome", async () => {
      const entered = deferred();
      const finish = deferred();
      const reading = deferred();
      const releaseRead = deferred();
      let gateRead = false;
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => {
          entered.resolve();
          await finish.promise;
          return acceptedCapture(h.seededRef);
        },
      });
      const getOperation = h.fixture.checkpoints.getOperation.bind(
        h.fixture.checkpoints,
      );
      vi.spyOn(h.fixture.checkpoints, "getOperation").mockImplementation(
        async (...args) => {
          const operation = await getOperation(...args);
          if (gateRead) {
            gateRead = false;
            reading.resolve();
            await releaseRead.promise;
          }
          return operation;
        },
      );
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        await entered.promise;
        await h.fixture.manager.skipConversationCheckpointHandoff({
          address: h.fixture.binding.address,
          operationId: started.operation.id,
        });
        gateRead = true;
        finish.resolve();
        await reading.promise;
        const cancelling = h.fixture.manager.cancelConversationCheckpoint({
          address: h.fixture.binding.address,
          operationId: started.operation.id,
        });
        await vi.waitFor(() =>
          expect(
            h.hosted().runtime?.maintenance?.controller.signal.aborted,
          ).toBe(true),
        );
        releaseRead.resolve();
        expect((await cancelling).kind).toBe("cancelled");
        expect(await started.completion).toMatchObject({
          phase: "cancelled",
          handoff: {
            stage: "omitted",
            omissionReason: "skipped",
            stopIntent: "skip",
          },
        });
      } finally {
        finish.resolve();
        releaseRead.resolve();
        await h.close();
      }
    });

    it("skip before dispatch settles the written control without submitting capture", async () => {
      const reached = deferred();
      const write = deferred();
      const capture = vi.fn(async () => acceptedCapture(h.seededRef));
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: capture,
        appendCaptureEntryOnce: async (id, entry, append) => {
          if (entry.origin?.checkpointCapture?.part === "control") {
            reached.resolve();
            await write.promise;
          }
          await append(id, entry);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        await reached.promise;
        expect(
          (
            await h.fixture.manager.skipConversationCheckpointHandoff({
              address: h.fixture.binding.address,
              operationId: started.operation.id,
            })
          ).kind,
        ).toBe("stopping");
        expect(h.state.laneCalls).toEqual([]);
        write.resolve();
        expect(await started.completion).toMatchObject({
          phase: "ready",
          handoff: {
            stage: "omitted",
            omissionReason: "skipped",
            submitted: false,
            auditDurable: true,
          },
        });
        expect(capture).not.toHaveBeenCalled();
      } finally {
        write.resolve();
        await h.close();
      }
    });

    it("cancel waits for capture audit and finalizes only after the write", async () => {
      const reached = deferred();
      const write = deferred();
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => acceptedCapture(h.seededRef),
        appendCaptureEntryOnce: async (id, entry, append) => {
          if (entry.origin?.checkpointCapture?.part === "settlement") {
            reached.resolve();
            await write.promise;
          }
          await append(id, entry);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        await reached.promise;
        const queued = await h.enqueue("held through audit cancellation");
        let done = false;
        const cancelling = h.fixture.manager
          .cancelConversationCheckpoint({
            address: h.fixture.binding.address,
            operationId: started.operation.id,
          })
          .then((result) => {
            done = true;
            return result;
          });
        await vi.waitFor(async () =>
          expect(
            (await h.operation(started.operation.id))?.handoff?.stopIntent,
          ).toBe("cancel"),
        );
        expect(done).toBe(false);
        expect((await h.readRow()).pendingQueue).toMatchObject([
          { id: queued.id, status: "pending" },
        ]);
        expect((await h.operation(started.operation.id))?.phase).toBe(
          "building",
        );
        write.resolve();
        expect((await cancelling).kind).toBe("cancelled");
        expect(await started.completion).toMatchObject({
          phase: "cancelled",
          handoff: { omissionReason: "cancelled", auditDurable: true },
        });
        expect(h.state.laneCalls).toEqual([]);
      } finally {
        write.resolve();
        await h.close();
      }
    });

    it.each(["settlement", "generation", "freeze"] as const)(
      "keeps cancellation provenance with lost continuity at %s",
      async (boundary) => {
        const reached = deferred();
        const release = deferred();
        const h = await createCheckpointHarness({
          scope,
          captureHandoff: async () => ({
            ...acceptedCapture(h.seededRef),
            continuation: {
              disposition: "clear",
              backendRef: null,
              nextRuntime: "unavailable",
            },
          }),
          generate: async (...args) => {
            if (boundary === "generation") {
              reached.resolve();
              await release.promise;
            }
            return generateCheckpoint(...args);
          },
          repo: (real) => ({
            ...real,
            settleCapture: async (input) => {
              const result = await real.settleCapture(input);
              if (
                boundary === "settlement" &&
                input.settlement.kind === "result"
              ) {
                reached.resolve();
                await release.promise;
              }
              return result;
            },
            freezePayload: async (input) => {
              if (boundary === "freeze") {
                reached.resolve();
                await release.promise;
              }
              return real.freezePayload(input);
            },
          }),
        });
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          await reached.promise;
          const captured = (await h.operation(started.operation.id))?.handoff;
          expect(captured?.stage).toBe("captured");
          const queued = await h.enqueue(
            "held after cancellation loses continuity",
          );
          const cancelling = h.fixture.manager.cancelConversationCheckpoint({
            address: h.fixture.binding.address,
            operationId: started.operation.id,
          });
          await vi.waitFor(() =>
            expect(
              h.hosted().runtime?.maintenance?.controller.signal.aborted,
            ).toBe(true),
          );
          release.resolve();
          await cancelling;
          expect(await started.completion).toMatchObject({
            phase: "needs_reconciliation",
            handoff: {
              stage: "omitted",
              omissionReason: "cancelled",
              candidate: null,
              contentHash: captured?.contentHash,
              sourceCoverage: captured?.sourceCoverage,
              usage: captured?.usage,
            },
          });
          expect(
            await h.fixture.checkpoints.getPayload(
              h.scopeKey,
              started.operation.id,
            ),
          ).toBeNull();
          expect((await h.readRow()).pendingQueue).toMatchObject([
            { id: queued.id, status: "pending" },
          ]);
          expect(h.state.dispatches).toEqual([]);
        } finally {
          release.resolve();
          await h.close();
        }
      },
    );

    it("skip preserves a captured candidate and cancel finalizes its audit before freeze", async () => {
      const gate = gatedGenerator();
      const h = await createCheckpointHarness({
        scope,
        generate: gate.generate,
        captureHandoff: async () => acceptedCapture(h.seededRef),
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        await gate.started.promise;
        const captured = (await h.operation(started.operation.id))?.handoff;
        expect(captured?.stage).toBe("captured");
        expect(
          (
            await h.fixture.manager.skipConversationCheckpointHandoff({
              address: h.fixture.binding.address,
              operationId: started.operation.id,
            })
          ).kind,
        ).toBe("handoff_already_settled");
        expect((await h.operation(started.operation.id))?.handoff).toEqual(
          captured,
        );
        const cancelled = await h.fixture.manager.cancelConversationCheckpoint({
          address: h.fixture.binding.address,
          operationId: started.operation.id,
        });
        expect(cancelled.kind).toBe("cancelled");
        expect(await started.completion).toMatchObject({
          phase: "cancelled",
          handoff: {
            stage: "omitted",
            omissionReason: "cancelled",
            candidate: null,
            contentHash: captured?.contentHash,
            sourceCoverage: captured?.sourceCoverage,
            usage: captured?.usage,
          },
        });
        expect(
          await h.fixture.checkpoints.getPayload(
            h.scopeKey,
            started.operation.id,
          ),
        ).toBeNull();
      } finally {
        gate.release();
        await h.close();
      }
    });

    it("submits one capture after durable running intent using the source model and continuity", async () => {
      const capture = vi.fn(async () => {
        const operation = await h.operation(requestId);
        expect(operation?.handoff?.stage).toBe("running");
        return {
          modeEstablished: true,
          submitted: true,
          correlatedCompletion: true,
          candidateText: JSON.stringify({
            plan: [],
            hypotheses: [],
            failedApproaches: [],
            blockers: [],
            nextStep: [],
          }),
          omissionReason: null,
          executionSettled: true,
          cleanupFailure: null,
          continuation: {
            disposition: "retain" as const,
            backendRef: h.seededRef,
            nextRuntime: "recreate_from_ref" as const,
          },
          activity: {
            transport: "complete" as const,
            native: "unavailable" as const,
            prohibited: "not_observed" as const,
            inspectedBytes: null,
          },
          usage: {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            costUsd: null,
            costBasis: null,
            executionMs: 1,
            settlementMs: 1,
          },
        };
      });
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: capture,
      });
      const requestId = randomUUID();
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId,
            handoff: { mode: "tool-disabled" },
          }),
        );
        const operation = await started.completion;
        expect(capture).toHaveBeenCalledTimes(1);
        expect(operation).toMatchObject({
          phase: "ready",
          handoff: { stage: "included" },
        });
        expect(h.latestRuntime().input).toMatchObject({
          persistedRef: h.seededRef,
          initialPurpose: { kind: "checkpoint_handoff", mode: "tool-disabled" },
        });
        expect(h.state.dispatches).toEqual([]);
        expect((await h.readRow()).promptCount).toBe(2);
      } finally {
        await h.close();
      }
    });

    it("seals the capture sink after its final durable settlement", async () => {
      const sink = deferred<CaptureHandoffInput>();
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async (input) => {
          sink.resolve(input);
          return acceptedCapture(h.seededRef);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect((await started.completion).phase).toBe("ready");
        const before = h.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT)?.length;
        await expect(
          (await sink.promise).onTranscript({
            backend: "claude",
            seq: 99,
            type: "late",
            raw: { late: true },
          }),
        ).rejects.toThrow("settled");
        expect(h.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT)?.length).toBe(
          before,
        );
      } finally {
        await h.close();
      }
    });

    it("holds generation and queued input until the settlement audit is durable", async () => {
      const barrier = deferred();
      const reached = deferred();
      const capturedEntries: (TranscriptEntry & { id: string })[] = [];
      const ordinaryMemory = vi.fn(async () => null);
      const notepad = vi.fn(async () => null);
      const alignment = vi.fn(async () => null);
      const h = await createCheckpointHarness({
        scope,
        actorDeps: {
          getMemoryIndexBlock: ordinaryMemory,
          readNotepadForInjection: notepad,
          getActiveAlignmentInjection: alignment,
        },
        appendCaptureEntryOnce: async (id, entry, append) => {
          capturedEntries.push(entry);
          if (entry.origin?.checkpointCapture?.part === "settlement") {
            reached.resolve();
            await barrier.promise;
          }
          await append(id, entry);
        },
        captureHandoff: async (input) => {
          await input.onTranscript({
            backend: "claude",
            seq: 0,
            type: "native",
            raw: {
              timestamp: "2026-01-01T00:00:00Z",
              type: "user",
              role: "user",
              content: [{ type: "text", text: "CAPTURE_CONTROL_NOT_A_TASK" }],
              origin: { source: "user" },
              raw: { native: "kept" },
            },
          });
          return acceptedCapture(h.seededRef);
        },
      });
      try {
        const requestId = randomUUID();
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId,
            handoff: { mode: "tool-disabled" },
          }),
        );
        await reached.promise;
        await h.enqueue("queued after capture");
        await h.nudge();
        expect(h.state.laneCalls).toEqual([]);
        expect(h.state.dispatches).toEqual([]);
        expect((await h.readRow()).promptCount).toBe(2);
        expect(ordinaryMemory).not.toHaveBeenCalled();
        expect(notepad).not.toHaveBeenCalled();
        expect(alignment).not.toHaveBeenCalled();
        expect((await h.operation(requestId))?.handoff?.stage).toBe("running");
        expect(capturedEntries.map((entry) => entry.id)).toEqual(
          capturedEntries.map((_, index) => `${requestId}:capture:${index}`),
        );
        expect(
          capturedEntries.every(
            (entry) => entry.origin?.source === "checkpoint_capture",
          ),
        ).toBe(true);
        expect(
          capturedEntries.find((entry) => entry.type === "user")?.raw,
        ).toEqual({ native: "kept" });
        barrier.resolve();
        const operation = await started.completion;
        expect(operation.phase).toBe("ready");
        expect(operation.handoff?.usage?.inputTokens).toBe(50);
        expect(
          h.state.laneCalls.every(
            (call) => !call.prompt.includes("CAPTURE_CONTROL_NOT_A_TASK"),
          ),
        ).toBe(true);
      } finally {
        barrier.resolve();
        await h.close();
      }
    });

    it("retains maintenance when a required capture audit write fails", async () => {
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => acceptedCapture(h.seededRef),
        appendCaptureEntryOnce: async (id, entry, append) => {
          if (entry.origin?.checkpointCapture?.part === "settlement")
            throw new Error("disk unavailable");
          await append(id, entry);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect(await started.completion).toMatchObject({
          phase: "needs_reconciliation",
          failure: { code: "capture_cleanup_unverified" },
        });
        await h.enqueue("held after failed audit");
        await h.nudge();
        expect(h.state.dispatches).toEqual([]);
        expect(h.state.laneCalls).toEqual([]);
        expect(h.hosted().runtime?.maintenance).toBeDefined();
      } finally {
        await h.close();
      }
    });

    it("never advances the owned source basis over an unrelated append during capture", async () => {
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => {
          const entries = h.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT);
          if (!entries) throw new Error("missing archive");
          entries.push(
            transcriptText(
              (entries.at(-1)?.seq ?? -1) + 1,
              "user",
              "UNRELATED_REQUEST",
            ),
          );
          return acceptedCapture(h.seededRef);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        const operation = await started.completion;
        expect(operation.phase).toBe("failed");
        expect(operation.sourceBasis).toEqual(started.operation.sourceBasis);
        expect(operation.handoff?.finalSourceBasis).toEqual(
          started.operation.sourceBasis,
        );
        expect(
          await h.fixture.checkpoints.getPayload(h.scopeKey, operation.id),
        ).toBeNull();
        expect(h.state.laneCalls).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it("rejects a changed live model before freezing capture", async () => {
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => {
          h.latestRuntime().runtime.modelSelection.parameters.effort = "low";
          return acceptedCapture(h.seededRef);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        const operation = await started.completion;
        expect(operation.phase).toBe("failed");
        expect(
          await h.fixture.checkpoints.getPayload(h.scopeKey, operation.id),
        ).toBeNull();
      } finally {
        await h.close();
      }
    });

    it("fails a known source race before submission without holding settled cleanup", async () => {
      const capture = vi.fn(async () => acceptedCapture(h.seededRef));
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: capture,
        appendCaptureEntryOnce: async (id, entry, append) => {
          await append(id, entry);
          if (entry.type === "checkpoint_capture_control")
            h.fixture.setBackgroundActivity(null);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect((await started.completion).phase).toBe("failed");
        expect(capture).not.toHaveBeenCalled();
        expect(h.hosted().runtime?.maintenance).toBeUndefined();
        expect(h.latestRuntime().close).toHaveBeenCalled();
      } finally {
        await h.close();
      }
    });

    it("compares the full opaque continuation identity", async () => {
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () =>
          acceptedCapture({
            backend: "codex",
            ref: h.seededRef?.ref ?? "missing",
          }),
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect((await started.completion).phase).toBe("failed");
        expect(
          await h.fixture.checkpoints.getPayload(
            h.scopeKey,
            started.operation.id,
          ),
        ).toBeNull();
      } finally {
        await h.close();
      }
    });

    it("freezes the included handoff and source boundary in the same durable payload transition", async () => {
      let inspectedFreeze = false;
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => acceptedCapture(h.seededRef),
        generate: async (input, deps) => {
          expect(
            await h.fixture.checkpoints.getPayload(
              h.scopeKey,
              input.identity.checkpointId,
            ),
          ).toBeNull();
          expect(
            (await h.operation(input.identity.checkpointId))?.handoff?.stage,
          ).toBe("captured");
          return generateCheckpoint(input, deps);
        },
        repo: (repo) => ({
          ...repo,
          async freezePayload(input) {
            const result = await repo.freezePayload(input);
            if (result.ok) {
              const operation = await repo.getOperation(
                input.key,
                input.operationId,
              );
              const payload = await repo.getPayload(
                input.key,
                input.operationId,
              );
              expect(operation).toMatchObject({
                phase: "retiring",
                handoff: {
                  stage: "included",
                  candidate: null,
                  auditDurable: true,
                },
              });
              expect(payload).toEqual(input.payload);
              expect(operation?.sourceBasis).toEqual(
                operation?.handoff?.finalSourceBasis,
              );
              inspectedFreeze = true;
            }
            return result;
          },
        }),
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        const operation = await started.completion;
        expect(operation.phase).toBe("ready");
        expect(inspectedFreeze).toBe(true);
        expect(operation.sourceBasis.capturedThroughSeq).toBeGreaterThan(
          operation.handoff?.admissionSourceBasis.capturedThroughSeq ?? 0,
        );
      } finally {
        await h.close();
      }
    });

    it("atomically omits an otherwise valid handoff when the combined working-state budget is exhausted", async () => {
      const candidate = {
        plan: Array.from({ length: 3 }, () => ({
          kind: "belief",
          text: "H".repeat(1500),
          sourceRefs: [],
        })),
        hypotheses: [],
        failedApproaches: [],
        blockers: [],
        nextStep: [],
      };
      const capture = vi.fn(async () => ({
        ...acceptedCapture(h.seededRef),
        candidateText: JSON.stringify(candidate),
      }));
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: capture,
        workingStateObjectiveText: "E".repeat(16000),
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        const operation = await started.completion;
        expect(operation).toMatchObject({
          phase: "ready",
          handoff: {
            stage: "omitted",
            omissionReason: "seed_budget",
            candidate: null,
          },
        });
        const payload = await h.fixture.checkpoints.getPayload(
          h.scopeKey,
          operation.id,
        );
        expect(payload?.seedText).toContain("E".repeat(16000));
        expect(payload?.seedText).not.toContain("H".repeat(1500));
        expect(payload?.sectionBytes.total).toBe(
          Buffer.byteLength(payload?.seedText ?? ""),
        );
        expect(capture).toHaveBeenCalledTimes(1);
        expect(h.state.laneCalls).toHaveLength(2);
      } finally {
        await h.close();
      }
    });

    it("disposes an unused capture binding before a failed baseline releases ordinary admission", async () => {
      let available = true;
      const capture = vi.fn(async () => acceptedCapture(h.seededRef));
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: capture,
        captureAvailability: () =>
          available
            ? { available: true, mode: "tool-disabled" }
            : { available: false, mode: "tool-disabled", reason: "changed" },
        appendCaptureEntryOnce: async (id, entry, append) => {
          await append(id, entry);
          if (entry.type === "checkpoint_capture_control") available = false;
        },
        generate: async () => {
          throw new Error("generation failed");
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect(await started.completion).toMatchObject({
          phase: "failed",
          handoff: { omissionReason: "mode_changed" },
        });
        expect(capture).not.toHaveBeenCalled();
        expect(h.latestRuntime().close).toHaveBeenCalledTimes(1);
        expect(h.hosted().runtime?.managed.backend).toBeUndefined();
        await h.runOrdinaryTurn("continue after omitted capture");
        expect(h.latestRuntime().input.initialPurpose).toBeUndefined();
        expect(h.state.dispatches).toEqual(["continue after omitted capture"]);
      } finally {
        await h.close();
      }
    });

    it("keeps the audit sink owned while capture cleanup remains unverified", async () => {
      const input = deferred<CaptureHandoffInput>();
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async (captureInput) => {
          input.resolve(captureInput);
          return {
            ...acceptedCapture(h.seededRef),
            candidateText: null,
            omissionReason: "cleanup_unverified",
            executionSettled: false,
            cleanupFailure: {
              code: "cleanup_unverified",
              message: "child still owned",
            },
          };
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect((await started.completion).phase).toBe("needs_reconciliation");
        const persisted = await h.fixture.checkpoints.getOperation(
          h.scopeKey,
          started.operation.id,
        );
        const observed = acceptedCapture(h.seededRef);
        expect(persisted).toMatchObject({
          phase: "needs_reconciliation",
          payloadId: null,
          handoff: {
            stage: "omitted",
            submitted: true,
            modeEstablished: true,
            correlatedCompletion: true,
            executionSettled: false,
            auditDurable: false,
            omissionReason: "cleanup_unverified",
            candidate: null,
            activity: observed.activity,
            usage: observed.usage,
          },
        });
        await h.enqueue("held despite observed capture submission");
        await h.nudge();
        expect(h.state.dispatches).toEqual([]);
        await expect(
          (await input.promise).onTranscript({
            backend: "claude",
            seq: 5,
            type: "trailing",
            raw: { trailing: "activity" },
          }),
        ).resolves.toBeUndefined();
        const audit = h.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT) ?? [];
        expect(
          audit.some(
            (entry) => entry.origin?.checkpointCapture?.part === "settlement",
          ),
        ).toBe(false);
        expect(h.hosted().runtime?.maintenance).toBeDefined();
        expect(h.state.laneCalls).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it("does not invent capture audit writes when no mode was disclosed or submitted", async () => {
      const append = vi.fn(async () => {
        throw new Error("audit writer unavailable");
      });
      const h = await createCheckpointHarness({
        scope,
        appendCaptureEntryOnce: append,
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: null },
          }),
        );
        expect(await started.completion).toMatchObject({
          phase: "ready",
          handoff: { omissionReason: "unavailable", submitted: false },
        });
        expect(append).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    });

    it("runtime cleanup awaits a trailing capture audit receipt after an unsettled result", async () => {
      const captured = deferred<CaptureHandoffInput>();
      const barrier = deferred();
      const writing = deferred();
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async (input) => {
          captured.resolve(input);
          return {
            ...acceptedCapture(h.seededRef),
            candidateText: null,
            omissionReason: "cleanup_unverified",
            executionSettled: false,
            cleanupFailure: {
              code: "cleanup_unverified",
              message: "still owned",
            },
          };
        },
        appendCaptureEntryOnce: async (id, entry, append) => {
          if (entry.origin?.checkpointCapture?.part === "activity") {
            writing.resolve();
            await barrier.promise;
          }
          await append(id, entry);
        },
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        expect((await started.completion).phase).toBe("needs_reconciliation");
        const receipt = (await captured.promise).onTranscript({
          backend: "claude",
          seq: 10,
          type: "trailing",
          raw: { trailing: true },
        });
        await writing.promise;
        let closed = false;
        const closing = h
          .hosted()
          .runtime?.managed.close()
          .then(() => {
            closed = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(closed).toBe(false);
        barrier.resolve();
        await receipt;
        await closing;
        expect(closed).toBe(true);
      } finally {
        barrier.resolve();
        await h.close();
      }
    });

    it.each([
      { name: "SDK failure", reason: "capture_failed" as const },
      { name: "empty answer", reason: "invalid_output" as const },
      {
        name: "mode setup failed",
        reason: "mode_establishment_failed" as const,
      },
      { name: "execution limit", reason: "execution_limit" as const },
      {
        name: "native violation with silent transport",
        reason: "prohibited_activity" as const,
      },
      {
        name: "supplied native record inspection failed",
        reason: "native_inspection_incomplete" as const,
      },
    ])("settled $name falls back without resubmission", async ({ reason }) => {
      const capture = vi.fn(
        async (input: CaptureHandoffInput): Promise<CaptureHandoffResult> => {
          expect(input.limits).toEqual(CHECKPOINT_CAPTURE_LIMITS);
          expect(Buffer.byteLength(input.promptText)).toBeLessThanOrEqual(
            input.limits.inputBytes,
          );
          const base = acceptedCapture(h.seededRef);
          return {
            ...base,
            candidateText: null,
            omissionReason: reason,
            ...(reason === "mode_establishment_failed"
              ? {
                  modeEstablished: false,
                  submitted: false,
                  correlatedCompletion: false,
                }
              : {}),
            activity: {
              ...base.activity,
              ...(reason === "prohibited_activity"
                ? { prohibited: "observed" }
                : {}),
              ...(reason === "native_inspection_incomplete"
                ? { native: "incomplete" }
                : {}),
            },
          };
        },
      );
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: capture,
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        const operation = await started.completion;
        expect(operation).toMatchObject({
          phase: "ready",
          handoff: {
            stage: "omitted",
            omissionReason: reason,
            executionSettled: true,
            auditDurable: true,
          },
        });
        expect(capture).toHaveBeenCalledTimes(1);
        expect(h.state.laneCalls).toHaveLength(2);
      } finally {
        await h.close();
      }
    });

    it.each([
      { name: "malformed", answer: "not JSON", reason: "invalid_output" },
      {
        name: "invalid original reference",
        answer: JSON.stringify({
          plan: [
            {
              kind: "reported_observation",
              text: "unsupported",
              sourceRefs: [{ messageIndex: 999, seqStart: 999, seqEnd: 999 }],
            },
          ],
          hypotheses: [],
          failedApproaches: [],
          blockers: [],
          nextStep: [],
        }),
        reason: "invalid_output",
      },
      {
        name: "oversized",
        answer: "x".repeat(CHECKPOINT_CAPTURE_LIMITS.outputBytes + 1),
        reason: "output_limit",
      },
    ])(
      "omits $name output without capture repair",
      async ({ answer, reason }) => {
        const capture = vi.fn(async () => ({
          ...acceptedCapture(h.seededRef),
          candidateText: answer,
        }));
        const h = await createCheckpointHarness({
          scope,
          captureHandoff: capture,
        });
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          expect(await started.completion).toMatchObject({
            phase: "ready",
            handoff: { stage: "omitted", omissionReason: reason },
          });
          expect(capture).toHaveBeenCalledTimes(1);
          expect(h.state.laneCalls).toHaveLength(2);
        } finally {
          await h.close();
        }
      },
    );

    it.each([
      "missing-method",
      "unavailable",
      "setup-exception",
      "failed-close",
    ] as const)(
      "handles %s through the registered manager path",
      async (failure) => {
        const capture = vi.fn(async () => acceptedCapture(h.seededRef));
        const h = await createCheckpointHarness({
          scope,
          ...(failure !== "missing-method" ? { captureHandoff: capture } : {}),
          ...(failure === "unavailable"
            ? {
                captureAvailability: () => ({
                  available: false as const,
                  mode: "tool-disabled" as const,
                  reason: "not supported",
                }),
              }
            : {}),
          ...(failure === "setup-exception"
            ? {
                actorDeps: {
                  getConversationBackendFactory: () => ({
                    backend: "claude" as const,
                    validateModelSelection() {},
                    createRuntime: async () => {
                      throw new Error("setup failed");
                    },
                  }),
                },
              }
            : {}),
        });
        if (failure === "failed-close") h.state.closeRejects = true;
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          const operation = await started.completion;
          expect(operation.phase).toBe(
            failure === "failed-close" ? "needs_reconciliation" : "ready",
          );
          if (failure === "failed-close") {
            expect(h.state.laneCalls).toEqual([]);
            expect(h.hosted().runtime?.maintenance).toBeDefined();
          } else {
            expect(capture).not.toHaveBeenCalled();
            expect(operation.handoff?.omissionReason).toBe(
              failure === "setup-exception"
                ? "mode_establishment_failed"
                : "unavailable",
            );
          }
        } finally {
          h.state.closeRejects = false;
          h.hosted().runtime?.managed.reconcileClose();
          await h.close();
        }
      },
    );

    it.each(["prefix", "forged-origin", "activity", "background"] as const)(
      "rejects %s changes while capture owns the source",
      async (change) => {
        const h = await createCheckpointHarness({
          scope,
          captureHandoff: async (input) => {
            const entries = h.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT);
            if (!entries) throw new Error("missing archive");
            if (change === "prefix")
              entries[0] = transcriptText(0, "user", "REPLACED_ORIGINAL");
            if (change === "forged-origin")
              entries.push({
                ...transcriptText(
                  (entries.at(-1)?.seq ?? -1) + 1,
                  "assistant",
                  "foreign",
                ),
                origin: {
                  source: "checkpoint_capture",
                  checkpointCapture: {
                    captureId: input.captureId,
                    operationId: input.captureId.replace(/:capture$/, ""),
                    part: "output",
                  },
                },
              });
            if (change === "activity")
              await h.hosted().runtime?.managed.track(Promise.resolve());
            if (change === "background") h.fixture.setBackgroundActivity(null);
            return acceptedCapture(h.seededRef);
          },
        });
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          const operation = await started.completion;
          expect(operation.phase).toBe("failed");
          expect(operation.sourceBasis).toEqual(started.operation.sourceBasis);
          expect(
            await h.fixture.checkpoints.getPayload(h.scopeKey, operation.id),
          ).toBeNull();
        } finally {
          await h.close();
        }
      },
    );

    it("rejects an audit-only archive mutation during generation", async () => {
      const gate = gatedGenerator();
      const h = await createCheckpointHarness({
        scope,
        generate: gate.generate,
        captureHandoff: async () => acceptedCapture(h.seededRef),
      });
      try {
        const started = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId: randomUUID(),
            handoff: { mode: "tool-disabled" },
          }),
        );
        await gate.started.promise;
        const entry = h.fixture.transcripts
          .get(CHECKPOINT_TRANSCRIPT)
          ?.find((entry) => entry.origin?.checkpointCapture?.part === "output");
        if (!entry) throw new Error("missing captured audit");
        entry.content = [
          { type: "text", text: "AUDIT_MUTATED_WITHOUT_EVIDENCE_HASH_CHANGE" },
        ];
        gate.release();
        const operation = await started.completion;
        expect(operation).toMatchObject({
          phase: "failed",
          failure: { code: "source_changed" },
          handoff: {
            stage: "omitted",
            omissionReason: "checkpoint_failed",
            candidate: null,
          },
        });
        expect(
          await h.fixture.checkpoints.getPayload(h.scopeKey, operation.id),
        ).toBeNull();
      } finally {
        gate.release();
        await h.close();
      }
    });

    it.each([false, true])(
      "generation failure preserves safe ownership (lost continuation: %s)",
      async (lost) => {
        const h = await createCheckpointHarness({
          scope,
          captureHandoff: async () =>
            lost
              ? {
                  ...acceptedCapture(h.seededRef),
                  candidateText: null,
                  omissionReason: "capture_failed",
                  continuation: {
                    disposition: "clear",
                    backendRef: null,
                    nextRuntime: "unavailable",
                  },
                }
              : acceptedCapture(h.seededRef),
          generate: async () => {
            throw new Error("generation failed");
          },
        });
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              handoff: { mode: "tool-disabled" },
            }),
          );
          const operation = await started.completion;
          expect(operation.phase).toBe(
            lost ? "needs_reconciliation" : "failed",
          );
          expect(operation.handoff).toMatchObject({
            stage: "omitted",
            candidate: null,
            omissionReason: lost ? "capture_failed" : "checkpoint_failed",
          });
          expect(
            await h.fixture.checkpoints.getPayload(h.scopeKey, operation.id),
          ).toBeNull();
          if (lost) expect(h.hosted().runtime?.maintenance).toBeDefined();
        } finally {
          await h.close();
        }
      },
    );

    it.each([
      { name: "off", handoff: undefined, ref: undefined, reason: null },
      {
        name: "changed disclosure",
        handoff: { mode: "instruction-only" as const },
        ref: undefined,
        reason: "mode_changed",
      },
      {
        name: "missing continuity",
        handoff: { mode: "tool-disabled" as const },
        ref: null,
        reason: "continuity_unavailable",
      },
    ])(
      "$name performs no provider allocation or capture submission",
      async ({ handoff, ref, reason }) => {
        const capture = vi.fn();
        const h = await createCheckpointHarness({
          scope,
          seededRef: ref,
          captureHandoff: capture,
        });
        try {
          const started = h.admittedOr(
            await h.fixture.manager.startConversationCheckpoint({
              address: h.fixture.binding.address,
              requestId: randomUUID(),
              ...(handoff ? { handoff } : {}),
            }),
          );
          const operation = await started.completion;
          expect(operation.phase).toBe("ready");
          expect(operation.handoff?.omissionReason ?? null).toBe(reason);
          expect(capture).not.toHaveBeenCalled();
          expect(h.state.created).toEqual([]);
        } finally {
          await h.close();
        }
      },
    );

    it("durably records explicit no-mode opt-in and rejoins the original choice", async () => {
      const gate = gatedGenerator();
      const h = await createCheckpointHarness({
        scope,
        generate: gate.generate,
      });
      try {
        const requestId = randomUUID();
        const first = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId,
            handoff: { mode: null },
          }),
        );
        const rejoined = h.admittedOr(
          await h.fixture.manager.startConversationCheckpoint({
            address: h.fixture.binding.address,
            requestId,
            handoff: { mode: "instruction-only" },
          }),
        );
        expect((await h.operation(first.operation.id))?.handoff).toMatchObject({
          requestedMode: null,
          captureId: `${requestId}:capture`,
          backend: "claude",
        });
        expect(rejoined.kind).toBe("reused");
        expect(h.state.created).toHaveLength(0);
        gate.release();
        expect(await first.completion).toMatchObject({
          phase: "ready",
          handoff: {
            stage: "omitted",
            omissionReason: "unavailable",
            submitted: false,
          },
        });
      } finally {
        gate.release();
        await h.close();
      }
    });
  },
);
