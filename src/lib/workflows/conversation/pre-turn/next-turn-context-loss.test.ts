import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "@/lib/project-conversations/system-prompt";
import { readRuntimeInstructions } from "../runtime-instructions";
import { createActorDependenciesFixture } from "../testing/actor-deps-fixture";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { runtimeConfigurationFixture } from "../testing/runtime-configuration-fixture";
import { describe, expect, it, vi } from "vitest";

import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import {
  decideMemoryIndexDelivery,
  isRuntimeCreatedWithoutResume,
} from "@/lib/memory/delivery-decision";
import type { SessionState } from "@/lib/sessions/schemas";

import {
  readNextTurnContextLoss,
  type NextTurnContextLossDeps,
  type NextTurnConversationFacts,
} from "./next-turn-context-loss";
import {
  shouldRecreateRuntime,
  willNextTurnCreateRuntime,
  type DesiredRuntimeConfiguration,
  type RecreateRuntimeSnapshot,
} from "./runtime-recreate";

const MODEL: BackendModelSelection = {
  modelId: "claude-opus-5",
  parameters: {},
};

const CONVERSATION = "conv-1";

/** A continuing conversation with no stored handle: the state a loss matters in. */
const CONTINUING: NextTurnConversationFacts = {
  projectPath: "/repo",
  sessionName: "feature-x",
  promptCount: 3,
  hasResumeHandle: false,
  pendingCheckpoint: false,
};

function makeDeps(overrides: {
  conversation?: NextTurnConversationFacts | null;
  runtime?: RecreateRuntimeSnapshot | undefined;
  creationMode?: SessionState["creationMode"] | undefined;
  activeAlignmentVersion?: number | null;
}): NextTurnContextLossDeps {
  return {
    async findConversation() {
      return overrides.conversation === undefined
        ? CONTINUING
        : overrides.conversation;
    },
    getRuntimeConfiguration() {
      return overrides.runtime;
    },
    async readDesiredRuntimeConfiguration(conversationId, current) {
      const conversation = overrides.conversation ?? CONTINUING;
      const fixture = createActorDependenciesFixture();
      vi.mocked(fixture.getSessionState).mockResolvedValue(
        sessionStateSchema.parse({
          sessionName: "feature-x",
          worktreePath: "/repo/worktree",
          branchName: "feature-x",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          creationMode: overrides.creationMode ?? "normal",
          tddEnabled: false,
        }),
      );
      vi.mocked(fixture.getActiveAlignmentInjection).mockResolvedValue(
        overrides.activeAlignmentVersion == null
          ? null
          : {
              version: overrides.activeAlignmentVersion,
              text: "charter",
              contentHash: "fixture-charter",
            },
      );
      const projection = await readRuntimeInstructions(
        { execution: fixture, context: fixture },
        {
          projectPath: conversation.projectPath,
          worktreePath: "/repo/worktree",
          target: targetFromStoreSessionName(
            "repo",
            conversation.sessionName ?? "__project__",
            conversationId,
          ),
          turn: current.instructionSelection,
        },
        undefined,
      );
      return {
        ...current,
        alignmentVersion: projection.alignmentVersion,
        repeatableInstructions: projection.repeatableInstructions,
      };
    },
  };
}

/** A live runtime that started under alignment charter version `version`. */
function aliveRuntime(version: number | null): RecreateRuntimeSnapshot {
  return {
    ...runtimeConfigurationFixture(),
    status: "alive",
    modelSelection: MODEL,
    alignmentVersion: version,
    repeatableInstructions: [
      ...runtimeConfigurationFixture().repeatableInstructions,
      ...(version === null ? [] : ["charter"]),
    ],
  };
}

describe("readNextTurnContextLoss", () => {
  it("reports a loss when the next turn must build a runtime from nothing", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({ runtime: undefined }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(true);
  });

  it("reports a loss when the only registered runtime is dead", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({ runtime: { ...aliveRuntime(2), status: "dead" } }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(true);
  });

  it("reports no loss when a live runtime still matches the conversation", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({ runtime: aliveRuntime(2), activeAlignmentVersion: 2 }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(false);
  });

  it("reports a loss when the charter was amended since the runtime started", async () => {
    // The defect this pins: `/align` bumps the charter while the conversation
    // sits idle, so the next turn CLOSES this live runtime and builds a new one
    // to bake the new version in (R7.3). With no resume handle that is a
    // context loss, and a preview that treated any alive runtime as reusable
    // would promise a delta the turn will not deliver.
    const loss = await readNextTurnContextLoss(
      makeDeps({ runtime: aliveRuntime(2), activeAlignmentVersion: 3 }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(true);
  });

  it("reports a loss for a pending checkpoint, whose fresh runtime resumes nothing by design", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({
        conversation: { ...CONTINUING, pendingCheckpoint: true },
        runtime: undefined,
      }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(true);
  });

  it("reports no loss from charter drift when a resume handle survives it", async () => {
    // Recreating a runtime is only a context loss when nothing carries the
    // conversation across: the new runtime resumes from the stored handle.
    const loss = await readNextTurnContextLoss(
      makeDeps({
        conversation: { ...CONTINUING, hasResumeHandle: true },
        runtime: aliveRuntime(2),
        activeAlignmentVersion: 3,
      }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(false);
  });

  it("reads no charter for a session whose turns it cannot govern", async () => {
    // Alignment governs attended NORMAL sessions only (R12.1/R12.2), so an
    // optimistic session's runtime bakes no version and none is desired —
    // there is nothing here to drift.
    const loss = await readNextTurnContextLoss(
      makeDeps({
        creationMode: "optimistic",
        runtime: aliveRuntime(null),
        activeAlignmentVersion: 7,
      }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(false);
  });

  it("reads no charter for a project conversation, which has no session", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({
        conversation: { ...CONTINUING, sessionName: null },
        runtime: {
          ...aliveRuntime(null),
          repeatableInstructions: [
            PROJECT_CC_CONTEXT,
            ...runtimeConfigurationFixture().repeatableInstructions.slice(1),
            PROJECT_SPAWN_INSTRUCTIONS,
          ],
        },
        activeAlignmentVersion: 7,
      }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(false);
  });

  it("reports no loss for a lane runtime carrying a schema and a write envelope", async () => {
    // The mirror-image defect. A dispatch-supplied dimension is invisible to
    // this reader in BOTH directions: comparing a lane's baked schema and
    // envelope against "nothing desired" would find drift on every structured
    // -output lane and preview a full block for all of them. Reading the
    // runtime's own values is what keeps a conversation at rest reading as at
    // rest. The opposite direction — a next dispatch supplying something
    // different — is the intended divergence pinned in "the dispatch-supplied
    // boundary" below.
    const loss = await readNextTurnContextLoss(
      makeDeps({
        runtime: {
          ...aliveRuntime(4),
          status: "alive",
          modelSelection: MODEL,
          alignmentVersion: 4,
          outputFormat: {
            type: "json_schema",
            schema: { type: "object", properties: {} },
          },
          fsWritePolicy: {
            mode: "allowlist",
            allowWrite: ["src/lib/memory"],
            denyWrite: [],
          },
        },
        activeAlignmentVersion: 4,
      }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(false);
  });

  it("reports no loss for a conversation that has never completed a turn", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({ conversation: { ...CONTINUING, promptCount: 0 } }),
      CONVERSATION,
    );
    expect(loss.runtimeCreatedWithoutResume).toBe(false);
  });

  it("reports nothing for a conversation it cannot resolve", async () => {
    const loss = await readNextTurnContextLoss(
      makeDeps({ conversation: null, runtime: undefined }),
      CONVERSATION,
    );
    expect(loss).toEqual({
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: false,
    });
  });
});

/**
 * The pinned divergence (spec R12.2, criterion 2 of this context).
 *
 * Model selection, structured-output format, and a lane's write envelope are
 * supplied by whoever DISPATCHES the turn — named on submission, carried by a
 * structured-output request, composed from the lane's placement as the turn
 * starts. None of them is conversation state, so no reader outside a turn can
 * see the value the NEXT dispatch will supply, and this reader deliberately
 * does not guess: it answers for the conversation as it stands.
 *
 * The consequence is a real, intended disagreement, and it is pinned here so it
 * stays a decision instead of decaying into a silent gap: with the same live
 * runtime, this reader finds no context loss and the preview prints a delta,
 * while the turn — handed a different configuration — recreates the runtime and
 * is given a full block. The differing configuration is therefore expressed as a
 * VALUE handed to the recreation predicate, exactly as a dispatcher hands it in;
 * there is no state to mutate that would carry it.
 */
const DISPATCH_SUPPLIED_DRIFT: readonly {
  dimension: string;
  runtime: RecreateRuntimeSnapshot;
  nextDispatch: DesiredRuntimeConfiguration;
}[] = [
  {
    dimension: "a model named on the next submission",
    runtime: aliveRuntime(4),
    nextDispatch: {
      ...aliveRuntime(4),
      modelSelection: { modelId: "claude-sonnet-5", parameters: {} },
      alignmentVersion: 4,
    },
  },
  {
    dimension: "a structured-output schema the next request carries",
    runtime: aliveRuntime(4),
    nextDispatch: {
      ...aliveRuntime(4),
      modelSelection: MODEL,
      alignmentVersion: 4,
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", properties: {} },
      },
    },
  },
  {
    dimension: "a write envelope the next dispatch composes from placement",
    runtime: {
      ...aliveRuntime(4),
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: ["src/lib/memory"],
        denyWrite: [],
      },
    },
    nextDispatch: {
      ...aliveRuntime(4),
      modelSelection: MODEL,
      alignmentVersion: 4,
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: ["src/lib/workflows"],
        denyWrite: [],
      },
    },
  },
];

describe("the dispatch-supplied boundary", () => {
  it.each(DISPATCH_SUPPLIED_DRIFT)(
    "renders a delta for $dimension while the turn itself would compose a full block",
    async ({ runtime, nextDispatch }) => {
      // What the preview sees: a conversation at rest, whose live runtime
      // nothing in durable state contradicts.
      const loss = await readNextTurnContextLoss(
        makeDeps({ runtime, activeAlignmentVersion: 4 }),
        CONVERSATION,
      );
      expect(loss.runtimeCreatedWithoutResume).toBe(false);
      expect(
        decideMemoryIndexDelivery({ ...loss, hasDeliveryState: true }),
      ).toEqual({ mode: "delta", reset: false });

      // What the turn does with the configuration its dispatcher hands it. The
      // predicate is called in the argument shape the turn itself uses
      // (`executePromptForMachine`, which passes `input.outputFormat` and
      // `input.fsWritePolicy` straight from the submission) so this is the
      // production rule and not a restatement of it: the same runtime is now
      // drifted, so it is closed and rebuilt, and with no resume handle that
      // rebuild is a context loss.
      expect(
        shouldRecreateRuntime({
          current: { ...runtimeConfigurationFixture(), ...runtime },
          desired: runtimeConfigurationFixture({
            modelSelection: nextDispatch.modelSelection,
            outputFormat: nextDispatch.outputFormat,
            alignmentVersion: nextDispatch.alignmentVersion,
            fsWritePolicy: nextDispatch.fsWritePolicy,
          }),
        }),
      ).toBe(true);
      const willCreateRuntime = willNextTurnCreateRuntime({
        runtime,
        desired: nextDispatch,
      });
      expect(willCreateRuntime).toBe(true);
      expect(
        decideMemoryIndexDelivery({
          runtimeCreatedWithoutResume: isRuntimeCreatedWithoutResume({
            willCreateRuntime,
            promptCount: CONTINUING.promptCount,
            hasResumeHandle: CONTINUING.hasResumeHandle,
          }),
          backendReportedCompactionLastTurn: false,
          hasDeliveryState: true,
        }),
      ).toEqual({ mode: "full", reset: true });
    },
  );
});
