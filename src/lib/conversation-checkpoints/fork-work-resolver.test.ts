import { expect, it } from "vitest";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { checkpointWorkflowAssignments } from "./fork-workflow-assignments";
import {
  createCheckpointWorkResolver,
  type CheckpointWorkReaders,
} from "./fork-work-resolver";

const revision = {
  revision: { specId: "spec" },
  elements: [{ element: { id: "task", kind: "task" } }],
};
const specWork = {
  kind: "spec_task",
  specId: "spec",
  revisionId: "revision",
  elementId: "task",
} as const;
function readers(
  overrides: Partial<CheckpointWorkReaders> = {},
): CheckpointWorkReaders {
  return {
    ticket: async () => null,
    spec: async () => ({ projectPath: "/project" }),
    revision: async () => revision,
    execution: async () => null,
    ...overrides,
  };
}
it("rejects a missing ticket in the addressed project", async () => {
  await expect(
    createCheckpointWorkResolver(readers())("/project", {
      kind: "ticket",
      ticketNumber: 131,
    }),
  ).rejects.toMatchObject({ code: "related_work_not_found" });
});
it.each([
  readers({ spec: async () => ({ projectPath: "/other" }) }),
  readers({ revision: async () => null }),
  readers({
    revision: async () => ({ ...revision, revision: { specId: "other" } }),
  }),
  readers({ revision: async () => ({ ...revision, elements: [] }) }),
  readers({
    revision: async () => ({
      ...revision,
      elements: [{ element: { id: "task", kind: "requirement" } }],
    }),
  }),
])(
  "rejects a task outside the exact project, spec or revision",
  async (lookup) => {
    await expect(
      createCheckpointWorkResolver(lookup)("/project", specWork),
    ).rejects.toMatchObject({ code: "related_work_not_found" });
  },
);
it("accepts the addressed task revision without altering its snapshot", async () => {
  const before = JSON.stringify(revision);
  await expect(
    createCheckpointWorkResolver(readers())("/project", specWork),
  ).resolves.toBeUndefined();
  expect(JSON.stringify(revision)).toBe(before);
});
it("requires the workflow assignment's exact owner and use site", async () => {
  const execution = graphWorkflowExecutionSchema.parse(
    buildMaximalGraphWorkflowExecution(),
  );
  const choice = checkpointWorkflowAssignments(execution).find(
    (item) => item.owner.kind === "context" && item.useSite === "implementer",
  )!;
  const work = {
    kind: "workflow_assignment" as const,
    executionId: execution.id,
    sessionName: "session",
    owner: choice.owner,
    assignmentId: choice.assignmentId,
    useSite: choice.useSite,
  };
  const resolve = createCheckpointWorkResolver(
    readers({ execution: async () => execution }),
  );
  await expect(resolve("/project", work)).resolves.toBeUndefined();
  await expect(
    resolve("/project", {
      ...work,
      owner: { kind: "context", contextId: "missing-context" },
    }),
  ).rejects.toMatchObject({ code: "related_work_not_found" });
  await expect(
    resolve("/project", { ...work, useSite: "validator" }),
  ).rejects.toMatchObject({ code: "related_work_not_found" });
});
