import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { workflowDefinitionMutationSchema } from "./definition-schemas";
import { admitAuthoredWorkflowLaunch } from "./authored-launch-admission";
import {
  MAXIMAL_AUTHORED_LAUNCH_ACCOUNTABILITY_GROUPS,
  MAXIMAL_GRAPH_AFTER_ENVELOPE_CANARY,
  createMaximalAuthoredWorkflowLaunchFixture,
} from "./testing/maximal-authored-launch";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("maximal authored launch contract", () => {
  it("publishes one full-dialect fixture with the scoped graph-after-envelope canary", async () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    expect(workflowDefinitionMutationSchema.parse(launch)).toEqual(launch);
    expect(
      launch.definition.charter.invariants?.find(
        (invariant) => invariant.id === "graph-after-envelope-canary",
      )?.appliesTo,
    ).toEqual(MAXIMAL_GRAPH_AFTER_ENVELOPE_CANARY);

    const admitted = await admitAuthoredWorkflowLaunch(launch, {
      caller: "project-validate",
      documentScope: { kind: "project", projectPath: "/repo" },
      projectValidation: {
        commands: {
          lint: {
            command: { full: "scripts/validate/lint.sh" },
            cost: 1,
            pathArgs: "forbid",
          },
          format: {
            command: { full: "scripts/validate/format.sh" },
            cost: 1,
            pathArgs: "forbid",
          },
        },
        preMerge: ["lint"],
        laneMerge: ["lint"],
      },
      globalValidation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
      workflowDefaults: undefined,
      accountabilityGroups: MAXIMAL_AUTHORED_LAUNCH_ACCOUNTABILITY_GROUPS,
    });

    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.launch).toEqual(launch);
    expect(admitted.stableAccountabilityContextIds).toContain(
      "context-spawner",
    );
    expect(admitted.stableAccountabilityContextIds).toContain(
      "context-integrate",
    );
    expect(admitted.stableAccountabilityContextIds).not.toContain(
      "context-loop-worker",
    );
    expect(admitted.accountabilityGroupAnalysis).toEqual([
      expect.objectContaining({
        bindingKey: "stable-spawner",
        covered: true,
        mustRunClaimantContextIds: ["context-spawner"],
      }),
      expect.objectContaining({
        bindingKey: "post-loop-integration",
        covered: true,
        mustRunClaimantContextIds: ["context-integrate"],
      }),
      expect.objectContaining({
        bindingKey: "loop-template-is-not-claimable",
        covered: false,
        stableExistingClaimantContextIds: [],
      }),
    ]);
    expect(admitted.warnings).toEqual([
      expect.objectContaining({
        path: expect.stringContaining("outputSchema.properties.verdict.enum"),
        message: expect.stringContaining("defer"),
      }),
    ]);
  });

  it("keeps one authored launch schema", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src/lib/workflow-graph/definition-schemas.ts"),
      "utf8",
    );

    expect(source).not.toContain("export const workflowDefinitionDraftSchema");
  });
});
