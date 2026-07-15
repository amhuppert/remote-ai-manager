/**
 * Backend conformance suite (test-only): a shared `describe` block asserting
 * that a registered descriptor is internally coherent — id agreement across
 * facets, a valid model catalog, at least one execution facet, capability
 * declarations drawn from the closed vocabularies, continuity ref discipline,
 * and a failure classifier that normalizes anything without throwing. Every
 * registered backend (and any parameterized test descriptor) runs the same
 * contract, so a descriptor that lies about its facets fails here rather than
 * at a consumer.
 *
 * Continuity checks that drive the adapter's ports (ref round-trip, fork
 * coherence) only run when the caller supplies a harness: the descriptor must
 * then be built with fake SDK/service ports via its factory deps. Ref
 * discipline (mismatched-ref rejection) runs unconditionally — adapters must
 * reject a foreign ref before touching any port.
 *
 * Conversation-turn behavior checks assert each DECLARED capability against
 * OBSERVED runtime behavior (queue delivery, external-turn emission, native
 * structured-output forwarding, per-kind apply timing, cancellation, context
 * metrics), driven through the real factories/runners against fake provider
 * ports. The per-behavior check functions are exported so a suite can prove
 * a deliberately lying descriptor FAILS them, not just that truthful ones
 * pass.
 */

import { describe, expect, it } from "vitest";
import {
  capabilityApplyTimingSchema,
  capabilityKindSchema,
  continuationStrengthSchema,
  forkSupportSchema,
  queueDeliveryTimingSchema,
  skillTriggerPrefixSchema,
  structuredOutputSupportSchema,
  type AgentBackendDescriptor,
  type AgentBackendConversationFacet,
} from "./descriptor";
import { effortLevelSchema } from "./schemas";
import { agentFailureClassificationSchema } from "./errors";
import type {
  ContinuityContext,
  ContinuityStartInput,
  ForkInput,
} from "./continuity";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
} from "./conversation";
import type { AgentTaskRequest } from "./task";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { sleep } from "@/lib/shared/sleep";

export interface ContinuityConformanceHarness {
  /** Inputs the adapter's fake ports can satisfy on the happy path. */
  startInput: ContinuityStartInput;
  context: ContinuityContext;
  forkInput: ForkInput;
}

/**
 * Structured-output drive shared by the conversation and task facets: the
 * schema handed to the backend, the value the fake provider returns natively,
 * and a reader for the provider-port capture proving the schema was actually
 * forwarded to the provider (not just held above the seam).
 */
export interface StructuredOutputConformanceDrive {
  schema: Record<string, unknown>;
  expected: unknown;
  readForwardedSchema(): unknown;
}

/**
 * Drives real turns through a runtime built by the descriptor's factory (or
 * `createRuntime` for backends whose provider ports are constructor-injected),
 * for capability↔behavior coherence checks. The backing fake provider port
 * must script turn completion by prompt text: any ordinary prompt completes
 * with the backend's scripted frames; `hangingPromptText` never completes
 * until the turn's signal aborts; `queueHoldPromptText` (in-turn queue
 * backends only) completes after one more user input is consumed mid-turn.
 */
export interface ConversationTurnConformanceHarness {
  buildCreateInput(): ConversationBackendCreateInput;
  /**
   * Runtime constructor override. Defaults to the descriptor factory —
   * supply it only when the real runtime class takes its provider ports via
   * constructor DI (e.g. `new CodexConversationRuntime(input, fakeDeps)`).
   */
  createRuntime?(
    input: ConversationBackendCreateInput,
  ): Promise<ConversationBackendRuntime>;
  hangingPromptText: string;
  /** Required when `queue.deliveryTiming === "in_turn"`. */
  queueHoldPromptText?: string;
  /** Required when `externalTurns` is declared: makes the fake provider emit
   * one unsolicited out-of-turn provider turn. */
  triggerExternalTurn?(): void | Promise<void>;
  /** Required when conversation `structuredOutput === "backend_native"`. */
  structuredOutput?: StructuredOutputConformanceDrive;
}

/** Drives the real task runner through a fake provider port. */
export interface TaskConformanceHarness {
  buildRequest(): AgentTaskRequest;
  /** Required when `tasks.structuredOutput === "backend_native"`; the built
   * request must then carry `structuredOutput.schema` as its outputSchema. */
  structuredOutput?: StructuredOutputConformanceDrive;
}

export interface BackendConformanceHarness {
  continuity?: ContinuityConformanceHarness;
  conversationTurn?: ConversationTurnConformanceHarness;
  task?: TaskConformanceHarness;
}

// ============================================================
// Conversation-turn behavior checks (exported so lying descriptors can be
// proven to FAIL them)
// ============================================================

function buildTurnInput(
  promptText: string,
  signal?: AbortSignal,
): ConversationBackendTurnInput {
  return {
    promptText,
    imageRefs: [],
    sessionInstructions: [],
    autonomous: false,
    signal: signal ?? new AbortController().signal,
    onEvent: () => {},
  };
}

async function createRuntimeFor(
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
  overrides: Partial<ConversationBackendCreateInput> = {},
): Promise<ConversationBackendRuntime> {
  const input = { ...harness.buildCreateInput(), ...overrides };
  return harness.createRuntime
    ? harness.createRuntime(input)
    : facet.factory.createRuntime(input);
}

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(5);
  }
}

/**
 * `contextWindowMetrics` ⇔ turn-result metric presence. Declared true means
 * the backend reports enough to compute occupancy: BOTH `contextTokens` and
 * `contextWindowMax`. Declared false means occupancy is uncomputable —
 * `contextWindowMax` must be null (raw token usage may still be reported for
 * accounting, so `contextTokens` is not constrained).
 */
export async function checkContextMetricsCoherence(
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
): Promise<void> {
  const runtime = await createRuntimeFor(facet, harness);
  try {
    const result = await runtime.sendTurn(
      buildTurnInput("conformance metrics turn"),
    );
    expect(result.failure).toBeNull();
    if (facet.capabilities.contextWindowMetrics) {
      expect(typeof result.contextTokens).toBe("number");
      expect(typeof result.contextWindowMax).toBe("number");
    } else {
      expect(result.contextWindowMax).toBeNull();
    }
  } finally {
    runtime.close();
  }
}

/**
 * Queue declaration ⇔ live-delivery surface. `in_turn` backends must expose
 * `queueUserInput` and deliver mid-turn: the fake provider holds the
 * `queueHoldPromptText` turn open until the queued input is consumed, so the
 * turn can only complete if delivery really happened inside it. `next_turn`
 * backends must NOT expose a live-delivery method (callers route queued rows
 * above the seam by its absence).
 */
export async function checkQueueCoherence(
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
): Promise<void> {
  const runtime = await createRuntimeFor(facet, harness);
  try {
    if (facet.capabilities.queue.deliveryTiming === "in_turn") {
      if (harness.queueHoldPromptText === undefined) {
        throw new Error(
          "queue.deliveryTiming is 'in_turn' but the harness provides no queueHoldPromptText drive",
        );
      }
      expect(typeof runtime.queueUserInput).toBe("function");

      let turnResolved = false;
      const turnPromise = runtime
        .sendTurn(buildTurnInput(harness.queueHoldPromptText))
        .then((result) => {
          turnResolved = true;
          return result;
        });

      await runtime.queueUserInput!({
        content: [{ type: "text", text: "conformance queued input" }],
      });
      expect(turnResolved).toBe(false);

      const result = await turnPromise;
      expect(result.failure).toBeNull();
      expect(result.aborted).toBe(false);
    } else {
      expect(runtime.queueUserInput).toBeUndefined();
    }
  } finally {
    runtime.close();
  }
}

/**
 * `externalTurns` ⇔ out-of-turn emission. Declared true: unsolicited provider
 * activity must surface as `external_turn_started` … `external_turn_completed`
 * on the create input's `onExternalTurnEvent`. Declared false: a full
 * ordinary turn must emit NOTHING on that channel (a runtime misrouting turn
 * events into it fails here).
 */
export async function checkExternalTurnCoherence(
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
): Promise<void> {
  const externalEvents: ConversationBackendEvent[] = [];
  const runtime = await createRuntimeFor(facet, harness, {
    onExternalTurnEvent: (event) => {
      externalEvents.push(event);
    },
  });
  try {
    if (facet.capabilities.externalTurns) {
      if (!harness.triggerExternalTurn) {
        throw new Error(
          "externalTurns is declared but the harness provides no triggerExternalTurn drive",
        );
      }
      await harness.triggerExternalTurn();
      await waitUntil(
        () => externalEvents.some((e) => e.type === "external_turn_completed"),
        "external_turn_completed emission",
      );
      const startedIdx = externalEvents.findIndex(
        (e) => e.type === "external_turn_started",
      );
      const completedIdx = externalEvents.findIndex(
        (e) => e.type === "external_turn_completed",
      );
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(completedIdx).toBeGreaterThan(startedIdx);
    } else {
      const result = await runtime.sendTurn(
        buildTurnInput("conformance external-turn negative"),
      );
      expect(result.failure).toBeNull();
      expect(externalEvents).toEqual([]);
    }
  } finally {
    runtime.close();
  }
}

/**
 * Conversation-facet native structured output: the schema on the create input
 * must be forwarded to the provider port (observed via the harness capture)
 * and the provider's structured value must surface on the turn result.
 */
export async function checkConversationStructuredOutputForwarding(
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
): Promise<void> {
  const drive = harness.structuredOutput;
  if (!drive) {
    throw new Error(
      "conversation structuredOutput is 'backend_native' but the harness provides no structuredOutput drive",
    );
  }
  const runtime = await createRuntimeFor(facet, harness, {
    outputFormat: { type: "json_schema", schema: drive.schema },
  });
  try {
    const result = await runtime.sendTurn(
      buildTurnInput("conformance structured-output turn"),
    );
    expect(result.failure).toBeNull();
    expect(result.structuredOutput).toEqual(drive.expected);
    expect(drive.readForwardedSchema()).toBeDefined();
  } finally {
    runtime.close();
  }
}

/**
 * Cancellation: aborting an in-flight turn (production sequence — abort the
 * signal, then close the runtime) must resolve the turn as a clean
 * `aborted: true` result, never a classified failure.
 */
export async function checkCancellation(
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
): Promise<void> {
  const controller = new AbortController();
  const runtime = await createRuntimeFor(facet, harness);
  const turnPromise = runtime.sendTurn(
    buildTurnInput(harness.hangingPromptText, controller.signal),
  );
  // Let the dispatch reach the provider port before tearing it down.
  await sleep(10);
  controller.abort();
  runtime.close();
  const result = await turnPromise;
  expect(result.aborted).toBe(true);
  expect(result.failure).toBeNull();
}

/**
 * Per-kind apply-timing behavior. On an idle runtime every declared kind must
 * apply cleanly. While a turn is in flight the declared timing dictates the
 * disposition: `idle_live` must defer with `turn_active` (a live mutation
 * mid-turn would race the provider), `next_turn` must still report `applied`
 * (it only stages state the next turn ingests), and `next_conversation` may
 * report either (its effect lands at the next runtime regardless) but must
 * not be rejected.
 */
export async function checkApplyTimingBehavior(
  descriptor: AgentBackendDescriptor,
  facet: AgentBackendConversationFacet,
  harness: ConversationTurnConformanceHarness,
): Promise<void> {
  const cascadeFor = (
    kind: (typeof facet.capabilities.capabilityKinds)[number],
  ) => ({
    backend: descriptor.id,
    kinds: [{ kind: kind.kind, items: [] }],
  });

  const idleRuntime = await createRuntimeFor(facet, harness);
  try {
    for (const kind of facet.capabilities.capabilityKinds) {
      const result = await facet.runtimeConfig.apply({
        runtime: idleRuntime,
        resolved: cascadeFor(kind),
      });
      expect(result, `idle apply of kind '${kind.kind}'`).toEqual({
        status: "applied",
      });
    }
  } finally {
    idleRuntime.close();
  }

  const controller = new AbortController();
  const busyRuntime = await createRuntimeFor(facet, harness);
  const turnPromise = busyRuntime.sendTurn(
    buildTurnInput(harness.hangingPromptText, controller.signal),
  );
  try {
    await sleep(10);
    for (const kind of facet.capabilities.capabilityKinds) {
      const result = await facet.runtimeConfig.apply({
        runtime: busyRuntime,
        resolved: cascadeFor(kind),
      });
      if (kind.applyTiming === "idle_live") {
        expect(
          result,
          `mid-turn apply of idle_live kind '${kind.kind}'`,
        ).toEqual({ status: "deferred", reason: "turn_active" });
      } else if (kind.applyTiming === "next_turn") {
        expect(
          result,
          `mid-turn apply of next_turn kind '${kind.kind}'`,
        ).toEqual({ status: "applied" });
      } else {
        expect(
          result.status,
          `mid-turn apply of next_conversation kind '${kind.kind}'`,
        ).not.toBe("rejected");
      }
    }
  } finally {
    controller.abort();
    busyRuntime.close();
    await turnPromise.catch(() => {});
  }
}

/**
 * Task-facet behavior: the real runner completes a scripted run with a ref
 * owned by the descriptor, text, and usage; when the facet declares
 * `backend_native` structured output, the request's schema must reach the
 * provider port and the provider's structured value must surface.
 */
export async function checkTaskFacetBehavior(
  descriptor: AgentBackendDescriptor,
  harness: TaskConformanceHarness,
): Promise<void> {
  const tasks = descriptor.tasks;
  if (!tasks) {
    throw new Error(
      "task harness supplied for a descriptor with no tasks facet",
    );
  }
  const result = await tasks.runner.run(harness.buildRequest());
  expect(result.error).toBeNull();
  expect(result.timedOut).toBe(false);
  expect(result.backendRef?.backend).toBe(descriptor.id);
  expect(result.text).toBeTruthy();
  expect(result.usage).not.toBeNull();

  if (tasks.structuredOutput === "backend_native") {
    const drive = harness.structuredOutput;
    if (!drive) {
      throw new Error(
        "tasks structuredOutput is 'backend_native' but the harness provides no structuredOutput drive",
      );
    }
    expect(result.structuredOutput).toEqual(drive.expected);
    expect(drive.readForwardedSchema()).toBeDefined();
  }
}

export function describeBackendConformance(
  descriptor: AgentBackendDescriptor,
  harness: BackendConformanceHarness = {},
): void {
  describe(`backend conformance: ${descriptor.id}`, () => {
    it("agrees on its id across every declared facet", () => {
      if (descriptor.conversation) {
        expect(descriptor.conversation.factory.backend).toBe(descriptor.id);
        expect(descriptor.conversation.continuity.backend).toBe(descriptor.id);
        expect(descriptor.conversation.runtimeConfig.backend).toBe(
          descriptor.id,
        );
      }
      if (descriptor.tasks) {
        expect(descriptor.tasks.runner.backend).toBe(descriptor.id);
      }
      expect(descriptor.mcp.backend).toBe(descriptor.id);
    });

    it("declares at least one execution facet", () => {
      expect(
        descriptor.conversation !== undefined || descriptor.tasks !== undefined,
      ).toBe(true);
    });

    it("has valid metadata: label, prefix, model catalog, default model", () => {
      expect(descriptor.metadata.label.trim().length).toBeGreaterThan(0);
      expect(
        skillTriggerPrefixSchema.safeParse(
          descriptor.metadata.skillTriggerPrefix,
        ).success,
      ).toBe(true);
      expect(descriptor.metadata.toneToken.trim().length).toBeGreaterThan(0);

      const modelIds = descriptor.metadata.models.map((m) => m.id);
      expect(descriptor.metadata.models.length).toBeGreaterThan(0);
      expect(new Set(modelIds).size).toBe(modelIds.length);
      expect(modelIds).toContain(descriptor.metadata.defaultModelId);

      for (const model of descriptor.metadata.models) {
        expect(model.label.trim().length).toBeGreaterThan(0);
        for (const level of model.effortLevels) {
          expect(effortLevelSchema.safeParse(level).success).toBe(true);
        }
      }
    });

    it("declares conversation capabilities from the closed vocabularies", () => {
      const conversation = descriptor.conversation;
      if (!conversation) return;
      const caps = conversation.capabilities;
      expect(
        queueDeliveryTimingSchema.safeParse(caps.queue.deliveryTiming).success,
      ).toBe(true);
      expect(
        continuationStrengthSchema.safeParse(caps.continuationStrength).success,
      ).toBe(true);
      expect(forkSupportSchema.safeParse(caps.fork).success).toBe(true);
      expect(
        structuredOutputSupportSchema.safeParse(caps.structuredOutput).success,
      ).toBe(true);

      const kinds = caps.capabilityKinds.map((k) => k.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
      for (const support of caps.capabilityKinds) {
        expect(capabilityKindSchema.safeParse(support.kind).success).toBe(true);
        expect(
          capabilityApplyTimingSchema.safeParse(support.applyTiming).success,
        ).toBe(true);
      }
    });

    it("rejects a resolved cascade with an undeclared capability kind — never a silent drop", async () => {
      const conversation = descriptor.conversation;
      if (!conversation) return;
      const declared = new Set(
        conversation.capabilities.capabilityKinds.map((k) => k.kind),
      );
      const undeclared = capabilityKindSchema.options.find(
        (kind) => !declared.has(kind),
      );
      // Backend declares every kind — nothing to reject.
      if (!undeclared) return;
      const stubRuntime = {
        backend: descriptor.id,
        status: "alive" as const,
        modelId: undefined,
        reasoningEffort: undefined,
        outputFormat: undefined,
        alignmentVersion: null,
        async sendTurn(): Promise<never> {
          throw new Error("not used by conformance");
        },
        close() {},
      };
      const result = await conversation.runtimeConfig.apply({
        runtime: stubRuntime,
        resolved: {
          backend: descriptor.id,
          kinds: [{ kind: undeclared, items: [] }],
        },
      });
      expect(result.status).toBe("rejected");
    });

    it("continuity rejects a ref owned by a different backend on every ref-taking operation", async () => {
      const conversation = descriptor.conversation;
      if (!conversation) return;
      const foreignBackend = descriptor.id === "claude" ? "codex" : "claude";
      const foreignRef: AgentSessionRef = {
        backend: foreignBackend,
        ref: "foreign-ref",
      };
      const context: ContinuityContext = {
        projectPath: "/conformance",
        sessionName: "conformance",
      };
      const forkInput: ForkInput = {
        projectPath: "/conformance",
        anchorMessageId: null,
        sourceTranscriptPath: "/conformance/source.jsonl",
        messageIndex: 0,
      };

      await expect(
        conversation.continuity.validate(foreignRef, context),
      ).rejects.toThrow();
      await expect(
        conversation.continuity.resumeOrRecover(foreignRef, context),
      ).rejects.toThrow();
      await expect(
        conversation.continuity.fork(foreignRef, forkInput),
      ).rejects.toThrow();
    });

    const continuityHarness = harness.continuity;
    const conversationFacet = descriptor.conversation;
    if (conversationFacet && continuityHarness) {
      const continuity = conversationFacet.continuity;

      it("continuity ref round-trip: start mints an owned ref that validates and resumes", async () => {
        const ref = await continuity.start(continuityHarness.startInput);
        expect(ref.backend).toBe(descriptor.id);
        expect(ref.ref.length).toBeGreaterThan(0);

        const validation = await continuity.validate(
          ref,
          continuityHarness.context,
        );
        expect(validation).toEqual({ status: "valid" });

        const resumption = await continuity.resumeOrRecover(
          ref,
          continuityHarness.context,
        );
        expect(resumption.ref.backend).toBe(descriptor.id);
        expect(resumption.recovered).toBe(false);
      });

      it("fork coherence: the happy-path outcome kind matches the declared fork capability", async () => {
        const declared = conversationFacet.capabilities.fork;
        const sourceRef: AgentSessionRef = {
          backend: descriptor.id,
          ref: "conformance-fork-source",
        };
        const outcome = await continuity.fork(
          sourceRef,
          continuityHarness.forkInput,
        );
        const expectedKind =
          declared === "native"
            ? "native"
            : declared === "synthetic"
              ? "synthetic_seed"
              : "unsupported";
        expect(outcome.kind).toBe(expectedKind);
        if (outcome.kind === "native") {
          expect(outcome.ref.backend).toBe(descriptor.id);
        }
        if (outcome.kind === "synthetic_seed") {
          expect(outcome.seed.length).toBeGreaterThan(0);
        }
      });
    }

    const turnHarness = harness.conversationTurn;
    if (conversationFacet && turnHarness) {
      it("context-window metrics coherence: declared contextWindowMetrics matches the turn result", () =>
        checkContextMetricsCoherence(conversationFacet, turnHarness));

      it("queue coherence: declared delivery timing matches the live queueUserInput surface and mid-turn delivery", () =>
        checkQueueCoherence(conversationFacet, turnHarness));

      it("external-turn coherence: declared externalTurns matches out-of-turn emission", () =>
        checkExternalTurnCoherence(conversationFacet, turnHarness));

      if (
        conversationFacet.capabilities.structuredOutput === "backend_native"
      ) {
        it("structured-output forwarding: the schema reaches the provider and the native value surfaces", () =>
          checkConversationStructuredOutputForwarding(
            conversationFacet,
            turnHarness,
          ));
      }

      it("cancellation: aborting an in-flight turn resolves it as aborted, not failed", () =>
        checkCancellation(conversationFacet, turnHarness));

      it("apply-timing behavior: each declared capability kind applies per its declared timing", () =>
        checkApplyTimingBehavior(descriptor, conversationFacet, turnHarness));
    }

    const taskHarness = harness.task;
    if (descriptor.tasks && taskHarness) {
      it("task facet behavior: the runner completes a scripted run consistent with its declarations", () =>
        checkTaskFacetBehavior(descriptor, taskHarness));
    }

    it("declares task structured-output support from the closed vocabulary", () => {
      const tasks = descriptor.tasks;
      if (!tasks) return;
      expect(
        structuredOutputSupportSchema.safeParse(tasks.structuredOutput).success,
      ).toBe(true);
    });

    it("classifies timeout / abort / unknown failures without throwing", () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      const inputs: unknown[] = [
        abortError,
        new Error("Turn timed out after 120000ms"),
        { odd: "shape" },
        "plain string failure",
        undefined,
        null,
      ];
      for (const input of inputs) {
        const classification = descriptor.errors.classify(input);
        expect(
          agentFailureClassificationSchema.safeParse(classification).success,
        ).toBe(true);
      }
    });

    it("normalizes an abort into a non-retryable aborted classification preserving the message", () => {
      const abortError = new Error("turn aborted by user");
      abortError.name = "AbortError";
      const classification = descriptor.errors.classify(abortError);
      expect(classification.kind).toBe("aborted");
      expect(classification.retryable).toBe(false);
      expect(classification.message).toBe("turn aborted by user");
    });

    it("maps an unclassifiable failure to backend_error, never a throw or invalid kind", () => {
      const classification = descriptor.errors.classify({ odd: "shape" });
      expect(classification.kind).toBe("backend_error");
      expect(typeof classification.message).toBe("string");
      expect(classification.retryable).toBe(false);
    });
  });
}
