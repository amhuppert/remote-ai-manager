/**
 * The testfake descriptor's own contract: scripted event order, call-log
 * recording, distinct-from-real capability values (so the "pick the third
 * value" rule cannot silently erode), and the widened-schema round-trip for
 * the sanctioned test id.
 */

import { describe, expect, it } from "vitest";
import { agentBackendSchema } from "@/lib/shared/schemas";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
} from "../conversation";
import {
  claudeConversationCapabilities,
  claudeBackendMetadata,
} from "../claude/descriptor";
import {
  codexConversationCapabilities,
  codexBackendMetadata,
} from "../codex/descriptor";
import {
  claudeMcpCapabilities,
  codexMcpCapabilities,
} from "@/lib/mcp/backend-capabilities";
import {
  createTestFakeBackend,
  testWidenedAgentBackendSchema,
  TestFakeStaleRefError,
  TESTFAKE_BACKEND_ID,
  TESTFAKE_CONVERSATION_REF,
  TESTFAKE_TASK_REF,
  TESTFAKE_TASK_TEXT,
  TESTFAKE_TURN_TEXT,
} from "./testfake-backend";

function makeCreateInput(): ConversationBackendCreateInput {
  return {
    conversationId: "conv-testfake",
    projectPath: "/projects/fake",
    projectName: "fake",
    sessionName: "fake-session",
    worktreePath: "/projects/fake/.worktrees/fake-session",
    persistedRef: null,
    sessionInstructions: [],
    tooling: {},
  };
}

describe("TESTFAKE_BACKEND_ID", () => {
  it("round-trips the widened schema and is rejected by the production schema", () => {
    expect(testWidenedAgentBackendSchema.parse(TESTFAKE_BACKEND_ID)).toBe(
      "testfake",
    );
    expect(agentBackendSchema.safeParse(TESTFAKE_BACKEND_ID).success).toBe(
      false,
    );
  });
});

describe("createTestFakeBackend conversation runtime", () => {
  it("emits the scripted event order and resolves the deterministic result", async () => {
    const fake = createTestFakeBackend();
    const runtime =
      await fake.descriptor.conversation!.factory.createRuntime(
        makeCreateInput(),
      );
    const events: ConversationBackendEvent[] = [];

    const result = await runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events.map((e) => e.type)).toEqual([
      "backend_init",
      "content",
      "transcript_entry",
      "transcript_entry",
      "input_accepted",
    ]);
    const init = events[0]!;
    if (init.type !== "backend_init") throw new Error("unreachable");
    expect(init.backendRef).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_CONVERSATION_REF,
    });

    const frameEvents = events.filter(
      (
        e,
      ): e is Extract<ConversationBackendEvent, { type: "transcript_entry" }> =>
        e.type === "transcript_entry",
    );
    expect(frameEvents.map((e) => e.entry.raw)).toEqual(
      fake.conversationFrameMarkers.map((marker) => ({
        type: "testfake_frame",
        marker,
      })),
    );

    expect(result.backendRef).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_CONVERSATION_REF,
    });
    expect(result.contentBlocks).toEqual([
      { type: "text", text: TESTFAKE_TURN_TEXT },
    ]);
    // Coherence with the declared `contextWindowMetrics: false`.
    expect(result.contextTokens).toBeNull();
    expect(result.contextWindowMax).toBeNull();
    expect(result.failure).toBeNull();
    expect(result.continuationDisposition).toBe("retain");
  });

  it("records every operation in the call log and close() flips status to dead", async () => {
    const fake = createTestFakeBackend();
    const runtime =
      await fake.descriptor.conversation!.factory.createRuntime(
        makeCreateInput(),
      );
    await runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await runtime.applyPortableMcpConfig!({ servers: [] });
    expect(runtime.status).toBe("alive");
    runtime.close();
    expect(runtime.status).toBe("dead");

    expect(fake.calls.map((c) => c.op)).toEqual([
      "factory.createRuntime",
      "runtime.sendTurn",
      "runtime.applyPortableMcpConfig",
      "runtime.close",
    ]);
  });

  it("applyPortableMcpConfig reports the staging disposition matching betweenTurnApply", async () => {
    const fake = createTestFakeBackend();
    const runtime =
      await fake.descriptor.conversation!.factory.createRuntime(
        makeCreateInput(),
      );
    const applied = await runtime.applyPortableMcpConfig!({ servers: [] });
    expect(applied.disposition).toBe("deferred_to_next_turn");
    expect(fake.descriptor.mcp.betweenTurnApply).toBe("next-turn");
  });
});

describe("createTestFakeBackend continuity", () => {
  it("mints refs it can validate and resume; foreign-instance refs are stale", async () => {
    const fake = createTestFakeBackend();
    const continuity = fake.descriptor.conversation!.continuity;
    const context = { projectPath: "/p", sessionName: "s" };

    const ref = await continuity.start(context);
    expect(ref.backend).toBe(TESTFAKE_BACKEND_ID);
    expect(await continuity.validate(ref, context)).toEqual({
      status: "valid",
    });
    const resumed = await continuity.resumeOrRecover(ref, context);
    expect(resumed).toEqual({ ref, recovered: false });

    const foreignInstance = await continuity.validate(
      { backend: TESTFAKE_BACKEND_ID, ref: "fake-ref-999" },
      context,
    );
    expect(foreignInstance.status).toBe("stale");

    const orderedOps = fake.calls
      .map((c) => c.op)
      .filter((op) => op.startsWith("continuity."));
    expect(orderedOps).toEqual([
      "continuity.start",
      "continuity.validate",
      "continuity.resumeOrRecover",
      "continuity.validate",
    ]);
  });

  it("fork returns the declared unsupported outcome", async () => {
    const fake = createTestFakeBackend();
    const outcome = await fake.descriptor.conversation!.continuity.fork(
      { backend: TESTFAKE_BACKEND_ID, ref: "fake-ref-1" },
      {
        projectPath: "/p",
        anchorMessageId: null,
        sourceTranscriptPath: "/p/t.jsonl",
        messageIndex: 0,
      },
    );
    expect(outcome).toEqual({ kind: "unsupported" });
    expect(fake.descriptor.conversation!.capabilities.fork).toBe("unsupported");
  });
});

describe("createTestFakeBackend runtime-config adapter", () => {
  it("applies a cascade containing only declared kinds and rejects undeclared kinds", async () => {
    const fake = createTestFakeBackend();
    const runtime =
      await fake.descriptor.conversation!.factory.createRuntime(
        makeCreateInput(),
      );
    const adapter = fake.descriptor.conversation!.runtimeConfig;

    const applied = await adapter.apply({
      runtime,
      resolved: {
        backend: TESTFAKE_BACKEND_ID,
        kinds: [{ kind: "agents", items: [] }],
      },
    });
    expect(applied).toEqual({ status: "applied" });

    const rejected = await adapter.apply({
      runtime,
      resolved: {
        backend: TESTFAKE_BACKEND_ID,
        kinds: [{ kind: "skills", items: [] }],
      },
    });
    expect(rejected.status).toBe("rejected");
  });
});

describe("createTestFakeBackend task runner", () => {
  it("returns the scripted task result with testfake_frame transcript entries", async () => {
    const fake = createTestFakeBackend();
    const result = await fake.descriptor.tasks!.runner.run({
      workingDirectory: "/tmp",
      prompt: "do it",
      timeoutMs: 0,
      autonomous: true,
    });
    expect(result.text).toBe(TESTFAKE_TASK_TEXT);
    expect(result.backendRef).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_TASK_REF,
    });
    expect(result.transcript?.map((e) => e.raw)).toEqual(
      fake.taskFrameMarkers.map((marker) => ({
        type: "testfake_frame",
        marker,
      })),
    );
    expect(fake.calls.map((c) => c.op)).toContain("runner.run");
  });
});

describe("createTestFakeBackend failure classifier", () => {
  it("classifies aborts, the stale-ref sentinel, and unknown failures", () => {
    const fake = createTestFakeBackend();
    const abortError = new Error("stop");
    abortError.name = "AbortError";
    expect(fake.descriptor.errors.classify(abortError)).toEqual({
      kind: "aborted",
      message: "stop",
      retryable: false,
    });
    expect(
      fake.descriptor.errors.classify(new TestFakeStaleRefError()).kind,
    ).toBe("stale_resume_ref");
    expect(fake.descriptor.errors.classify({ odd: "shape" }).kind).toBe(
      "backend_error",
    );
  });
});

describe("distinct-from-real capability guard", () => {
  it("keeps observable capability values distinct from Claude and Codex where the vocabulary allows", () => {
    const fake = createTestFakeBackend();
    const caps = fake.descriptor.conversation!.capabilities;

    // Continuation strength differs from Claude's — the backend a silent
    // identity-fallback historically defaulted to ("none" would disable
    // continuation semantics entirely, so the Codex-shared value is the
    // strongest observable-yet-truthful choice per the design).
    expect(caps.continuationStrength).not.toBe(
      claudeConversationCapabilities.continuationStrength,
    );

    // Queue delivery timing differs from Claude's.
    expect(caps.queue.deliveryTiming).not.toBe(
      claudeConversationCapabilities.queue.deliveryTiming,
    );

    // The (kind, applyTiming) pair is declared by neither real backend.
    for (const support of caps.capabilityKinds) {
      for (const real of [
        claudeConversationCapabilities,
        codexConversationCapabilities,
      ]) {
        expect(
          real.capabilityKinds.some(
            (k) =>
              k.kind === support.kind && k.applyTiming === support.applyTiming,
          ),
        ).toBe(false);
      }
    }

    // MCP: strictAuthoritativeConfig and probeFallback differ from BOTH.
    expect(fake.descriptor.mcp.strictAuthoritativeConfig).not.toBe(
      claudeMcpCapabilities.strictAuthoritativeConfig,
    );
    expect(fake.descriptor.mcp.strictAuthoritativeConfig).not.toBe(
      codexMcpCapabilities.strictAuthoritativeConfig,
    );
    expect(fake.descriptor.mcp.toolDiscovery.probeFallback).not.toBe(
      claudeMcpCapabilities.toolDiscovery.probeFallback,
    );
    expect(fake.descriptor.mcp.toolDiscovery.probeFallback).not.toBe(
      codexMcpCapabilities.toolDiscovery.probeFallback,
    );

    // Model catalog shares no ids with the real catalogs.
    const realModelIds = new Set(
      [...claudeBackendMetadata.models, ...codexBackendMetadata.models].map(
        (m) => m.id,
      ),
    );
    for (const model of fake.descriptor.metadata.models) {
      expect(realModelIds.has(model.id)).toBe(false);
    }
  });
});
