import { describe, expect, it } from "vitest";
import {
  resolveContext,
  resolveContextDefaults,
  SEEDED_WORKFLOW_DEFAULTS,
} from "./resolve-config";
import { createWorkflowExecution } from "./test-fixtures";
import { applyLiveExecutionEdits, type LiveEditDeps } from "./runtime-edits";
import { buildDefaultAssignmentSnapshotPreparation } from "./live-edit-apply";
import { createValidationCommandPreflight } from "@/lib/validation/preflight";
import { repoValidationConfigSchema } from "@/lib/validation/schemas";
import type { ContextConfigOverrides } from "./resolve-config";
import type { WorkflowConfigOverride } from "./definition-schemas";

describe("context config defaults", () => {
  it.each([
    { workflow: {}, context: {} },
    {
      workflow: {
        collaboration: { enabled: true },
        scriptValidator: { commands: ["test"] },
        memory: { implementer: { read: "linked-only" } },
      },
      context: {},
    },
    {
      workflow: {
        collaboration: { enabled: true },
        scriptValidator: { commands: ["test"] },
      },
      context: {
        collaboration: { enabled: false },
        scriptValidator: { commands: [] },
        agentValidation: { implementer: { mode: "only", commands: [] } },
      },
    },
  ] satisfies {
    workflow: WorkflowConfigOverride;
    context: ContextConfigOverrides;
  }[])(
    "resolves the same values and provenance with actual config inputs: %j",
    ({ workflow, context }) => {
      const config = resolveContextDefaults(
        SEEDED_WORKFLOW_DEFAULTS,
        workflow,
        context,
      );
      const identity = {
        id: "context",
        title: "Context",
        acceptanceCriteria: "Complete",
        placement: { lane: "work", mode: "full" as const },
      };
      expect(
        resolveContext(SEEDED_WORKFLOW_DEFAULTS, workflow, {
          ...identity,
          ...context,
        }),
      ).toEqual({ ...identity, ...config });
      expect(config.collaboration.enabled.source).toBe(
        context.collaboration?.enabled !== undefined
          ? "per-node"
          : workflow.collaboration?.enabled !== undefined
            ? "workflow"
            : "global",
      );
      expect(config.scriptValidatorSource).toBe(
        context.scriptValidator !== undefined
          ? "per-node"
          : workflow.scriptValidator !== undefined
            ? "workflow"
            : "global",
      );
      expect(config).not.toHaveProperty("placement");
      expect(config).not.toHaveProperty("id");
    },
  );

  it("seeds a no-override live context with launch-equivalent defaults, composed profiles and registered validation commands", async () => {
    const global = {
      ...SEEDED_WORKFLOW_DEFAULTS,
      scriptValidator: { commands: ["test"] },
    };
    const config = resolveContextDefaults(global);
    const prepared = await buildDefaultAssignmentSnapshotPreparation(
      process.cwd(),
      [
        {
          type: "update-context",
          contextId: "context-plan",
          implementer: config.implementer,
          contextValidator: config.contextValidator,
        },
      ],
    );
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues));
    const snapshotFor = prepared.prepared.snapshotFor;
    const defaults = {
      ...config,
      implementer: {
        ...config.implementer,
        profileSnapshot: snapshotFor(config.implementer),
      },
      contextValidator: {
        ...config.contextValidator,
        assignments: config.contextValidator.assignments.map((assignment) => ({
          ...assignment,
          profileSnapshot: snapshotFor(assignment),
        })),
      },
    };
    const repoValidation = repoValidationConfigSchema.parse({
      commands: { test: { command: { full: "bun test" }, cost: 2 } },
    });
    const deps: LiveEditDeps = {
      createTaskId: () => "minted",
      resolvedGlobalDefaults: () => defaults,
      validationCommandPreflight: () =>
        createValidationCommandPreflight(repoValidation, undefined),
      snapshotFor,
      now: () => "2026-09-07T12:00:00.000Z",
    };
    const identity = {
      id: "context-defaults",
      title: "Defaults",
      acceptanceCriteria: "Use the registered checks",
      placement: { lane: "defaults", mode: "full" as const },
    };
    const result = applyLiveExecutionEdits(
      createWorkflowExecution({ status: "paused" }),
      {
        operations: [
          { type: "add-context", ...identity },
          {
            type: "add-task",
            id: "default-task",
            contextId: identity.id,
            title: "Work",
            instructions: "Complete the checks",
          },
        ],
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const added = result.execution.workingDefinition.executionContexts.find(
      (context) => context.id === identity.id,
    );
    expect(added).toMatchObject({
      ...resolveContext(global, {}, identity),
      ...defaults,
    });
    expect(added?.implementer.profileSnapshot.resolvedInstructionHash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(
      added?.contextValidator.assignments[0]?.profileSnapshot
        .renderedInstructionBlock,
    ).toContain("CC_AGENT_PROFILE_BEGIN");
    expect(added?.agentValidation?.implementer.commands).toEqual(["test"]);
    expect(added?.scriptValidatorSource).toBe("global");
  });
});
