import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";

/**
 * A valid maximal {@link WorkflowCharter} for test fixtures. Every optional
 * narrative section is populated and two ranked sources of truth are declared,
 * so construction sites that now require a charter on a definition or execution
 * can share one literal instead of duplicating it. Parsed through the real
 * schema so a fixture can never drift out of validity.
 *
 * Test-support only; not imported by production code.
 */
export function makeTestCharter(
  overrides: Partial<WorkflowCharter> = {},
): WorkflowCharter {
  return workflowCharterSchema.parse({
    mission: "Deliver the feature with a single authority model",
    conventions: [
      "Prefer early returns",
      "Zod schemas are the source of truth",
    ],
    nonGoals: ["Backward compatibility with pre-charter records"],
    vocabulary: ["charter: the workflow-global source-of-truth brief"],
    testStrategy: "TDD red-green-refactor with round-trip durability contracts",
    knownAmbiguities: ["scope of the AeroTrainer floor/round case"],
    sourcesOfTruth: [
      {
        rank: 1,
        id: "design-doc",
        label: "Approved design document",
        type: "document",
        locator: ".kiro/specs/workflow-charter/design.md",
        description: "The authoritative architecture for this workflow",
        appliesTo: "all execution contexts",
        accessPolicy: "worktree-relative",
      },
      {
        rank: 2,
        id: "acceptance-criteria",
        label: "Per-context acceptance criteria",
        type: "spec",
        locator: "context.acceptanceCriteria",
        description: "Context-level criteria; defer to higher-ranked sources",
        accessPolicy: "worktree-relative",
      },
    ],
    ...overrides,
  });
}
