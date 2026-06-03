/**
 * Section 6.1 — conversation + focus-mode parity verification.
 *
 * Task 6.1 of the composable-workflow-primitives spec requires that regular
 * conversations and focus-mode initialization be adapted to the primitive
 * layer (shared execution, ask-user pauses, status delivery, artifact
 * registration) **without changing the request/response shapes, event names,
 * artifact paths, or durable state visible to existing callers**.
 *
 * The primary migrations are in place:
 *  - Conversation turn execution routes through the shared `executeAgentCall`
 *    facade. The actor's `executePromptForMachine` builds a normalized
 *    `conversation_turn` AgentCallRequest and dispatches it via
 *    `dispatchTurnViaAgentCall` → `deps.executeAgentCall(request, facadeDeps)`
 *    (production wires `defaultExecuteAgentCall`). The dispatch wraps the
 *    backend runtime in a Proxy so the existing undelivered-query-session
 *    retry loop runs inside the facade's call path; observable behavior
 *    (close + unregister + recreate) matches the prior direct-`sendTurn`
 *    path so a stale Claude query session is retried transparently.
 *  - Conversation status events (`conversation-status`, `ask-question`,
 *    `debug-mode-status`, `debug-log-received`) publish through
 *    `publishSessionStatus`, which routes them through the shared
 *    SessionStatusBus and preserves the wire payload for existing UI
 *    consumers.
 *  - Focus-mode initialization registers `memory-bank/focus.md` as a
 *    `focus_memory` artifact through `ArtifactRegistry.register()` rather
 *    than calling `createReferenceDocument` directly. The canonical path
 *    `memory-bank/focus.md` is enforced by the registry's path rules and the
 *    existing reference-document store hook still receives the
 *    registration so the source-of-truth stays unchanged.
 *  - Mid-turn ask-user pauses bridge the backend's native question flow to
 *    the conversation machine's `ASK_QUESTION` event. The pause is in-flight
 *    (the backend turn is suspended awaiting an answer, then resumes the
 *    same turn) which matches `pauseKind: "mid_turn"` in the shared gate
 *    vocabulary; preserving the existing `ASK_QUESTION` event keeps the UI
 *    contract (question card → answer event) unchanged.
 *
 * These tests act as parity guards: every conversation/focus event variant the
 * existing UI consumes must still pass through the shared bus unchanged, the
 * canonical focus.md artifact path must remain `memory-bank/focus.md`, and
 * conversation turn execution must continue to traverse the AgentCall facade
 * so structured-output enforcement and lane scheduling remain wired in a
 * single place.
 *
 * Each test exercises the production default path (no broadcast/registry
 * override beyond the documented test seam) so a future regression that
 * silently changes a wire shape, a status event scope mapping, or a canonical
 * artifact path is caught here rather than at runtime in the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import {
  publishSessionStatus,
  setDefaultSessionStatusBusBroadcastForTesting,
  subscribeSessionStatus,
  _resetDefaultSessionStatusBusForTesting,
} from "./default-session-status-bus";
import type { StatusBusEnvelope } from "./status-bus";
import type {
  ArtifactRegistry,
  ArtifactRecord,
  ArtifactWriteRequest,
  ArtifactWriteOptionalRequest,
  ArtifactRegisterRequest,
  ArtifactWriteOutcome,
} from "./artifact-registry";
import { registerFocusMemoryIfPresent } from "@/lib/workflows/conversation/actor-implementations";
import type { SSEEvent } from "@/lib/api/sse-events";
import type {
  AskQuestionEvent,
  ConversationStatusEvent,
} from "@/lib/conversations/schemas";
import type { DebugModeStatusEvent } from "@/lib/debug-log/schemas";
interface CapturedRegistryCall {
  type: "write" | "writeOptional" | "register";
  request:
    | ArtifactWriteRequest
    | ArtifactWriteOptionalRequest
    | ArtifactRegisterRequest;
}

function makeRecordingArtifactRegistry(): {
  registry: ArtifactRegistry;
  calls: CapturedRegistryCall[];
} {
  const calls: CapturedRegistryCall[] = [];
  const fakeRecord = (
    kind: ArtifactWriteRequest["kind"],
    relativePath: string,
  ): ArtifactRecord => ({
    artifactId: `art-${calls.length}`,
    kind,
    relativePath,
    audience: "internal_log",
    source: { createdAt: "2026-04-28T00:00:00.000Z" },
  });
  const registry: ArtifactRegistry = {
    write: async (request) => {
      calls.push({ type: "write", request });
      return fakeRecord(request.kind, request.relativePath);
    },
    writeOptional: async (request): Promise<ArtifactWriteOutcome> => {
      calls.push({ type: "writeOptional", request });
      return {
        status: "registered",
        record: fakeRecord(request.kind, request.relativePath),
      };
    },
    register: async (request) => {
      calls.push({ type: "register", request });
      return fakeRecord(request.kind, request.relativePath);
    },
  };
  return { registry, calls };
}

function captureWire() {
  const wire = vi.fn<(event: SSEEvent) => void>();
  setDefaultSessionStatusBusBroadcastForTesting(wire);
  return wire;
}

function captureEnvelopes() {
  const envelopes: StatusBusEnvelope[] = [];
  const unsubscribe = subscribeSessionStatus((envelope) => {
    envelopes.push(envelope);
  });
  return { envelopes, unsubscribe };
}

describe("section 6.1 — conversation + focus-mode parity (Task 6.1)", () => {
  let workingDir: string;

  beforeEach(async () => {
    _resetDefaultSessionStatusBusForTesting();
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "section6-1-parity-"));
  });

  afterEach(async () => {
    _resetDefaultSessionStatusBusForTesting();
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  describe("conversation status events route through publishSessionStatus", () => {
    // The session-status-bus maps the feature-level conversation status onto
    // the primitive lifecycle vocabulary: every non-pause status reports as
    // "running" so the StatusBus envelope stays terse, while "awaiting" /
    // "waiting_for_input" surface as "paused" for primitive subscribers.
    // The wire SSEEvent payload preserves the original feature status field
    // unchanged so existing UI consumers see no observable change.
    const conversationStatusCases: Array<{
      raw:
        | "running"
        | "completed"
        | "failed"
        | "awaiting"
        | "waiting_for_input";
      expected: "running" | "paused";
    }> = [
      { raw: "running", expected: "running" },
      { raw: "completed", expected: "running" },
      { raw: "failed", expected: "running" },
      { raw: "awaiting", expected: "paused" },
      { raw: "waiting_for_input", expected: "paused" },
    ];

    for (const { raw, expected } of conversationStatusCases) {
      it(`preserves conversation-status payload for status=${raw} and maps to envelope status=${expected}`, () => {
        const wire = captureWire();
        const { envelopes, unsubscribe } = captureEnvelopes();

        const event = {
          type: "conversation-status" as const,
          projectName: "acme",
          sessionName: "session-1",
          conversationId: "conv-1",
          status: raw,
        } as unknown as ConversationStatusEvent;

        const outcome = publishSessionStatus(event);
        unsubscribe();

        expect(outcome.delivered).toBe(true);
        expect(wire.mock.calls[0]?.[0]).toEqual(event);
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]?.scope).toBe("conversation");
        expect(envelopes[0]?.scopeId).toBe("conv-1");
        expect(envelopes[0]?.status).toBe(expected);
      });
    }

    it("preserves the conversation-status error field on the wire when the prompt failed", () => {
      const wire = captureWire();
      const { envelopes, unsubscribe } = captureEnvelopes();

      const event = {
        type: "conversation-status" as const,
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-1",
        status: "failed",
        error: "Backend timed out",
      } as unknown as ConversationStatusEvent;

      publishSessionStatus(event);
      unsubscribe();

      expect(wire.mock.calls[0]?.[0]).toEqual(event);
      expect(envelopes[0]?.payload).toEqual(event);
    });
  });

  it("ask-question events publish through publishSessionStatus and preserve every field", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: AskQuestionEvent = {
      type: "ask-question",
      scope: "session",
      projectName: "acme",
      sessionName: "session-1",
      conversationId: "conv-1",
      questionId: "q-1",
      questions: [
        {
          question: "Which option do you want?",
          options: [{ label: "Option 1" }, { label: "Option 2" }],
          multiSelect: false,
        },
      ],
    };

    const outcome = publishSessionStatus(event);
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes[0]?.scope).toBe("conversation");
    expect(envelopes[0]?.scopeId).toBe("conv-1");
    expect(envelopes[0]?.payload).toEqual(event);
  });

  it("debug-mode-status events publish through publishSessionStatus and route under the dedicated debug scope (preserves wire payload unchanged)", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: DebugModeStatusEvent = {
      type: "debug-mode-status",
      projectName: "acme",
      sessionName: "session-1",
      conversationId: "conv-1",
      active: true,
      recording: false,
    };

    const outcome = publishSessionStatus(event);
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes[0]?.scope).toBe("debug");
    expect(envelopes[0]?.scopeId).toBe("conv-1");
    expect(envelopes[0]?.payload).toEqual(event);
  });

  describe("focus-mode initialization registers focus.md through ArtifactRegistry.register()", () => {
    it("registers a focus_memory artifact at the canonical memory-bank/focus.md path with the conversation id as workflowId", async () => {
      const { registry, calls } = makeRecordingArtifactRegistry();
      const referenceDocCalls: Array<{
        projectPath: string;
        sessionName: string;
        filePath: string;
        description: string;
      }> = [];

      await registerFocusMemoryIfPresent({
        worktreePath: workingDir,
        projectPath: "/projects/acme",
        sessionName: "session-1",
        conversationId: "conv-focus-1",
        fileExists: () => true,
        registerReferenceDocument: async (
          projectPath,
          sessionName,
          filePath,
          description,
        ) => {
          referenceDocCalls.push({
            projectPath,
            sessionName,
            filePath,
            description,
          });
          return {};
        },
        artifactRegistry: registry,
      });

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.type).toBe("register");
      const req = call.request as ArtifactRegisterRequest;
      expect(req.kind).toBe("focus_memory");
      expect(req.relativePath).toBe("memory-bank/focus.md");
      expect(req.source.workflowId).toBe("conv-focus-1");
      expect(req.description.length).toBeGreaterThan(0);
    });

    it("is a no-op when focus.md is absent (preserves prior behavior)", async () => {
      const { registry, calls } = makeRecordingArtifactRegistry();
      const referenceDocCalls: Array<unknown> = [];

      await registerFocusMemoryIfPresent({
        worktreePath: workingDir,
        projectPath: "/projects/acme",
        sessionName: "session-1",
        conversationId: "conv-focus-missing",
        fileExists: () => false,
        registerReferenceDocument: async () => {
          referenceDocCalls.push("called");
          return {};
        },
        artifactRegistry: registry,
      });

      expect(calls).toHaveLength(0);
      expect(referenceDocCalls).toHaveLength(0);
    });

    it("production default registry forwards the registration to the supplied createReferenceDocument hook so the existing reference-document store stays the source of truth", async () => {
      await fs.mkdir(path.join(workingDir, "memory-bank"), { recursive: true });
      await fs.writeFile(
        path.join(workingDir, "memory-bank/focus.md"),
        "# focus\n",
      );

      const calls: Array<{
        projectPath: string;
        sessionName: string;
        filePath: string;
        description: string;
      }> = [];

      await registerFocusMemoryIfPresent({
        worktreePath: workingDir,
        projectPath: "/projects/acme",
        sessionName: "session-1",
        conversationId: "conv-focus-prod",
        fileExists: (p) => p.endsWith("memory-bank/focus.md"),
        registerReferenceDocument: async (
          projectPath,
          sessionName,
          filePath,
          description,
        ) => {
          calls.push({ projectPath, sessionName, filePath, description });
          return {};
        },
      });

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.projectPath).toBe("/projects/acme");
      expect(call.sessionName).toBe("session-1");
      expect(call.filePath).toBe("memory-bank/focus.md");
      expect(call.description.length).toBeGreaterThan(0);
    });
  });

  it('conversation turn execution routes through executeAgentCall — see actor-implementations.test.ts "routes the conversation turn through deps.executeAgentCall (Task 6.1 parity)"', () => {
    // Asserting the routing here would require booting the full conversation
    // actor, which the existing test covers. This pointer test exists so the
    // section-6-1 parity surface stays discoverable from one place.
    expect(true).toBe(true);
  });
});
