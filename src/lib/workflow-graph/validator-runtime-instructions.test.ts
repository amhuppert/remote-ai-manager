import { describe, expect, it } from "vitest";
import { prepareRuntimeInstructions } from "@/lib/workflows/conversation/runtime-instructions";
import {
  createActorDependenciesFixture,
  groupActorFixtureDependencies,
} from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import {
  ASK_QUESTION_INSTRUCTIONS,
  ASK_QUESTION_INSTRUCTIONS_ENABLED,
} from "@/lib/prompt/sdk-driver";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import {
  createWorkflowExecution,
  makeValidatorAssignment,
  seedAssignment,
} from "./test-fixtures";
import { assignmentFingerprint, laneStateKey } from "./lane-identity";
import { createValidatorRuntimeInstructionReader } from "./validator-runtime-instructions";
import {
  buildValidatorOutputSchema,
  issueCriterionCitationFor,
} from "./validator-output-schema";
import {
  freezeValidationCandidate,
  openValidationRound,
} from "./validation-round";
import type { RepoValidationConfig } from "@/lib/validation/schemas";

function fixture(authority: "blocking" | "advisory" = "blocking") {
  const execution = createWorkflowExecution();
  const context = execution.workingDefinition.executionContexts[0];
  if (!context) throw new Error("Expected fixture context");
  const assignment = seedAssignment(
    makeValidatorAssignment({
      id: "security",
      authority,
      profile: { tier: "project", id: "security" },
      focus: "Check the authorization boundary.",
    }),
    { renderedInstructionBlock: "PROFILE SECURITY SPECIALIZATION" },
  );
  context.contextValidator = { enabled: true, assignments: [assignment] };
  context.charter = {
    mission: "Preserve the widget API",
    nonGoals: [],
    invariants: [
      { id: "auth-boundary", statement: "Authorization remains enforced" },
      {
        id: "elsewhere",
        statement: "Hidden invariant",
        appliesTo: { contextIds: ["elsewhere"] },
      },
    ],
    sourcesOfTruth: [
      {
        id: "contract",
        rank: 1,
        type: "document",
        label: "Widget contract",
        locator: "docs/widget.md",
        description: "API contract",
        accessPolicy: "worktree-relative",
      },
      {
        id: "other",
        rank: 2,
        type: "document",
        label: "Hidden source",
        locator: "docs/other.md",
        description: "Other context",
        accessPolicy: "worktree-relative",
        appliesTo: { contextIds: ["elsewhere"] },
      },
    ],
  };
  context.acceptanceCriteria = [
    { id: "api", statement: "Widget contract holds" },
  ];
  context.agentValidation = {
    implementer: {
      value: { mode: "only", commands: [] },
      commands: [],
      source: "workflow",
    },
    contextValidator: {
      value: { mode: "only", commands: ["test"] },
      commands: ["test"],
      source: "workflow",
    },
  };
  context.scriptValidator = { commands: ["typecheck"] };
  execution.laneStates[context.id] = {
    [laneStateKey("context_validator", assignment.id)]: {
      lane: "context_validator",
      contextId: context.id,
      assignmentId: assignment.id,
      assignmentFingerprint: assignmentFingerprint(assignment),
      backend: assignment.agent.backend,
      workflowConversationId: "validator-conversation",
      metrics: {},
      lastUsedAt: "2026-09-20T00:00:00.000Z",
    },
  };
  const registry: RepoValidationConfig = {
    commands: {
      test: { command: { full: "test.sh" }, cost: 4, pathArgs: "forbid" },
      typecheck: {
        command: { full: "typecheck.sh" },
        cost: 2,
        pathArgs: "forbid",
      },
    },
    preMerge: [],
  };
  const identity = {
    projectPath: "/project",
    sessionName: "session",
    conversationId: "validator-conversation",
  };
  const reader = createValidatorRuntimeInstructionReader({
    getActiveExecution: async () => execution,
    readValidationConfig: async () => registry,
  });
  async function compose(askUserQuestionsEnabled: boolean) {
    const deps = groupActorFixtureDependencies(
      createActorDependenciesFixture({ getWorkflowLaneInstructions: reader }),
    );
    const instructions = await prepareRuntimeInstructions(
      deps,
      {
        projectPath: identity.projectPath,
        worktreePath: "/worktree",
        target: sessionConversationTarget(
          "project",
          identity.sessionName,
          identity.conversationId,
        ),
        turn: { askUserQuestionsEnabled, autonomous: true },
      },
      {
        instructionBlock: assignment.profileSnapshot.renderedInstructionBlock,
        snapshot: assignment.profileSnapshot,
        lockedAt: "2026-09-20T00:00:00.000Z",
      },
    );
    return instructions.sessionInstructions.join("\n\n");
  }
  return { execution, context, assignment, reader, identity, compose };
}

describe("validator instructions composed by the conversation actor", () => {
  it("delivers the scoped charter, registered validation policy, and blocking mandate before the persisted profile", async () => {
    const f = fixture();
    const instructions = await f.compose(true);
    expect(instructions).toContain("Preserve the widget API");
    expect(instructions).toContain("Widget contract");
    expect(instructions).toContain("auth-boundary");
    expect(instructions).toContain(".cc/graph-workflow-docs/charter.md");
    expect(instructions).not.toContain("Hidden invariant");
    expect(instructions).not.toContain("Hidden source");
    expect(instructions).toContain(
      "Enabled for you in this context: test (cost 4).",
    );
    expect(instructions).toContain(
      "Disabled for you in this context: typecheck.",
    );
    expect(instructions).toContain(
      "The script gate for this context runs `typecheck` separately",
    );
    expect(instructions).toContain("Check the authorization boundary.");
    expect(instructions.indexOf("## Mandate")).toBeLessThan(
      instructions.indexOf("PROFILE SECURITY SPECIALIZATION"),
    );
    expect(instructions.endsWith("PROFILE SECURITY SPECIALIZATION")).toBe(true);
    expect(instructions).toContain(
      JSON.stringify(
        buildValidatorOutputSchema({
          authority: f.assignment.authority,
          taskIds: f.execution.workingDefinition.tasks
            .filter((task) => task.contextId === f.context.id)
            .map((task) => task.id),
          criterionIds: ["api"],
          issueCriterionCitation: issueCriterionCitationFor(f.assignment),
        }),
      ),
    );
  });

  it.each([true, false])(
    "preserves the actor's ask variant for enabled=%s",
    async (enabled) => {
      const instructions = await fixture().compose(enabled);
      expect(instructions).toContain(
        enabled ? ASK_QUESTION_INSTRUCTIONS_ENABLED : ASK_QUESTION_INSTRUCTIONS,
      );
      expect(instructions).not.toContain(
        enabled ? ASK_QUESTION_INSTRUCTIONS : ASK_QUESTION_INSTRUCTIONS_ENABLED,
      );
    },
  );

  it("keeps advisory authority separate from a blocking mandate", async () => {
    const instructions = await fixture("advisory").compose(false);
    expect(instructions).toContain("You hold no blocking authority");
    expect(instructions).not.toContain("## Mandate");
    expect(instructions).toContain('"required":["summary","advisories"]');
    expect(instructions).not.toContain('"planDefects":');
  });

  it("leaves unrelated conversations without graph validator instructions", async () => {
    const f = fixture();
    expect(
      await f.reader({ ...f.identity, conversationId: "unrelated" }),
    ).toBeNull();
  });

  it("refuses assignment drift instead of changing a running validator's mandate", async () => {
    const f = fixture();
    f.assignment.focus = "A different mandate";
    await expect(f.reader(f.identity)).rejects.toThrow(/assignment.*changed/i);
  });

  it("checks the frozen review seat before composing a changed profile revision", async () => {
    const f = fixture();
    const state = f.execution.contextStates[f.context.id];
    if (!state) throw new Error("Expected fixture context state");
    state.validationRound = openValidationRound({
      previousRound: null,
      candidate: freezeValidationCandidate({
        tree: {
          identityScope: "wholeTree",
          headSha: "head",
          candidateTreeHash: "tree",
        },
        taskStates: f.execution.taskStates,
        contextId: f.context.id,
      }),
      assignments: [f.assignment],
      startedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(await f.reader(f.identity)).toContain(
      "Check the authorization boundary.",
    );
    f.assignment.profileSnapshot.revision++;
    await expect(f.reader(f.identity)).rejects.toThrow(/roster was frozen/);
  });
});
