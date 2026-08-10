import { describe, expect, it } from "vitest";

import { compileSpecExecutionPlan } from "@/lib/specs/compiler";
import {
  createSpecRouteHandlers,
  type SpecRouteDeps,
} from "@/lib/specs/route-handlers";
import { hashExecutionScope } from "@/lib/specs/execution-service";
import type { ExecutionScope } from "@/lib/specs/scope-validation";
import type {
  Spec,
  SpecRevision,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import type { SpecPlanPreviewView } from "@/lib/specs/view-schemas";

const PROJECT_PATH = "/repos/demo";
const CREATED_AT = "2026-08-07T00:00:00.000Z";
const LEGACY_PREVIEW_URL =
  "http://127.0.0.1:4999/api/specs/demo/native-sdd/plan-preview";

const spec: Spec = {
  id: "spec-1",
  projectPath: PROJECT_PATH,
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

function element(
  id: string,
  kind: SpecRevisionSnapshot["elements"][number]["element"]["kind"],
  number: number | null,
  parentElementId: string | null,
  position: number,
  payload: SpecRevisionSnapshot["elements"][number]["version"]["payload"],
): SpecRevisionSnapshot["elements"][number] {
  return {
    element: {
      id,
      specId: spec.id,
      kind,
      number,
      parentElementId,
      createdAt: CREATED_AT,
    },
    version: {
      revisionId: "revision-1",
      elementId: id,
      position,
      payload,
      payloadHash: `hash-${id}`,
      elementVersion: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  };
}

/** 22 criteria on one task, so the 20-brief section bound has to truncate. */
const WIDE_CRITERION_IDS = Array.from(
  { length: 22 },
  (_unused, index) => `criterion-wide-${index + 1}`,
);

function revisionIn(state: SpecRevision["state"]): SpecRevision {
  return {
    id: "revision-1",
    specId: spec.id,
    number: 3,
    state,
    authoringStage: "plan",
    basedOnRevisionId: null,
    contentHash: state === "approved" ? "content-hash" : null,
    proposedAt: state === "draft" ? null : CREATED_AT,
    approvedAt: state === "approved" ? CREATED_AT : null,
    createdAt: CREATED_AT,
  };
}

function snapshotIn(state: SpecRevision["state"]): SpecRevisionSnapshot {
  return {
    revision: revisionIn(state),
    elements: [
      element("requirement-1", "requirement", 1, null, 0, {
        kind: "requirement",
        statement: "Planners can read the compiled plan before launching it.",
        priority: "must",
        risk: "high",
      }),
      ...WIDE_CRITERION_IDS.map((id, index) =>
        element(id, "criterion", index + 1, "requirement-1", index + 1, {
          kind: "criterion",
          text: `Preview obligation ${index + 1} holds.`,
          validationStrategy: {
            kinds: index === 0 ? ["commit", "test_run"] : ["validator_verdict"],
            ...(index === 0
              ? { note: "Read the compiled section, then the lane commit." }
              : {}),
          },
        }),
      ),
      element("requirement-2", "requirement", 2, null, 30, {
        kind: "requirement",
        statement: "The preview is registered as a CLI verb.",
        priority: "must",
        risk: "low",
      }),
      element("criterion-verb", "criterion", 1, "requirement-2", 31, {
        kind: "criterion",
        text: "The verb is reachable as cctl spec plan preview.",
        validationStrategy: { kinds: ["validator_verdict"] },
      }),
      element("task-1", "task", 1, null, 40, {
        kind: "task",
        title: "Build the preview projection",
        instructions: "Materialize without launching.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: WIDE_CRITERION_IDS,
        dependsOnTaskElementIds: [],
      }),
      element("task-2", "task", 2, null, 41, {
        kind: "task",
        title: "Register the verb",
        instructions: "Wire it into the dispatcher and the help registry.",
        tracedRequirementElementIds: ["requirement-2"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-verb"],
        dependsOnTaskElementIds: ["task-1"],
      }),
    ],
  };
}

const FULL_SCOPE = {
  selectedTaskIds: ["task-1", "task-2"],
  selectedCriterionIds: [...WIDE_CRITERION_IDS, "criterion-verb"],
  exclusionDispositions: [],
};

function unusedDeps(): SpecRouteDeps {
  const absent = () => {
    throw new Error("the plan preview must not reach this dependency");
  };
  return {
    resolveProjectPath: absent,
    listSpecs: absent,
    resolveSpec: absent,
    listAliases: absent,
    listRevisions: absent,
    getRevisionSnapshot: absent,
    lintDraft: absent,
    findApprovalsBySpecId: absent,
    findCommentsByRevision: absent,
    findEventsBySpecId: absent,
    findGateAdmissionsBySpecId: absent,
    findLinksBySpecId: absent,
    getLinkedTickets: absent,
    findQuestionsBySpecId: absent,
    findAssumptionsBySpecId: absent,
    findExecutionsBySpecId: absent,
    findTaskClaimsBySpecId: absent,
    findWorkflowEventsByExecution: absent,
    reconcileExecution: absent,
    ingestExecutionEvidenceBestEffort: absent,
    findCriterionDispositionsByExecution: absent,
    findEvidenceByCriterionRevision: absent,
    findProofVerdictsByCriterionRevision: absent,
    findWaiverForCriterionRevision: absent,
    findWaiverById: absent,
    findWaiversByRevision: absent,
    exportSpec: absent,
    verifySpec: absent,
    measureProject: absent,
  };
}

function previewHandlers(state: SpecRevision["state"]) {
  const snapshot = snapshotIn(state);
  return createSpecRouteHandlers({
    ...unusedDeps(),
    async resolveProjectPath(name) {
      return name === "demo" ? PROJECT_PATH : null;
    },
    async resolveSpec(_projectPath, slug) {
      return slug === spec.slug ? spec : null;
    },
    async listAliases() {
      return [];
    },
    async listRevisions() {
      return [snapshot.revision];
    },
    async getRevisionSnapshot(revisionId) {
      return revisionId === snapshot.revision.id ? snapshot : null;
    },
  });
}

async function requestLegacyPreview(
  state: SpecRevision["state"],
  options: { body?: unknown; rawBody?: string } = {},
): Promise<Response> {
  const handlers = previewHandlers(state);
  const body =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  return handlers.planPreviewPOST(
    new Request(LEGACY_PREVIEW_URL, {
      method: "POST",
      ...(body === undefined ? {} : { body }),
    }),
    { params: Promise.resolve({ name: "demo", slug: "native-sdd" }) },
  );
}

async function readLegacyPreview(
  state: SpecRevision["state"] = "approved",
  body?: unknown,
): Promise<{ response: Response; preview: SpecPlanPreviewView }> {
  const response = await requestLegacyPreview(state, { body });
  return {
    response,
    preview: (await response.json()) as SpecPlanPreviewView,
  };
}

describe("legacy evergreen plan preview route compatibility", () => {
  it("returns exactly what the archived compiler produces for the same scope", async () => {
    const { response, preview } = await readLegacyPreview();
    expect(response.status).toBe(200);
    const compiled = compileSpecExecutionPlan({
      spec: { id: spec.id, slug: spec.slug, name: spec.name },
      revisionSnapshot: snapshotIn("approved"),
      scope: FULL_SCOPE,
      scopeHash: hashExecutionScope(FULL_SCOPE),
      approvalRequired: true,
    });

    expect(preview.scopeHash).toBe(hashExecutionScope(FULL_SCOPE));
    expect(preview.charter.mission).toBe(compiled.charter.mission);
    expect(preview.edges).toEqual(
      compiled.edges.map((edge) => ({
        id: edge.id,
        sourceContextId: edge.sourceContextId,
        targetContextId: edge.targetContextId,
      })),
    );
    for (const context of compiled.executionContexts) {
      const rendered = preview.contexts.find(
        (candidate) => candidate.contextId === context.id,
      );
      expect(rendered?.acceptanceCriteria).toBe(context.acceptanceCriteria);
      // Each listed brief is a verbatim piece of that same contract, so a
      // reader who sees the briefs has read what the validator receives.
      for (const brief of rendered?.criterionBriefs ?? []) {
        expect(context.acceptanceCriteria).toContain(brief.brief);
      }
    }
  });

  it("keeps draft legacy revisions readable even though launch compilation refuses them", async () => {
    expect(() =>
      compileSpecExecutionPlan({
        spec: { id: spec.id, slug: spec.slug, name: spec.name },
        revisionSnapshot: snapshotIn("draft"),
        scope: FULL_SCOPE,
        scopeHash: "scope-hash",
        approvalRequired: true,
      }),
    ).toThrow(/not approved/);

    const { response, preview } = await readLegacyPreview("draft");
    expect(response.status).toBe(200);
    expect(preview).toMatchObject({
      revision: { state: "draft" },
      totalContextCount: 2,
    });
  });

  it("reads a named legacy revision and refuses an unknown revision", async () => {
    const { response, preview } = await readLegacyPreview("approved", {
      revisionId: "revision-1",
    });
    expect(response.status).toBe(200);
    expect(preview).toMatchObject({
      revision: { id: "revision-1", number: 3 },
    });

    const missing = await requestLegacyPreview("approved", {
      body: { revisionId: "revision-404" },
    });
    expect(missing.status).toBe(404);
  });

  // A malformed body meant to NARROW the preview must not be answered with the
  // whole plan: that reply is wider than the request and indistinguishable
  // from a correct one. An absent body stays the explicit full-plan request.
  it("refuses a malformed body instead of widening to the whole plan", async () => {
    const malformed = await requestLegacyPreview("approved", {
      rawBody: '{"scope":',
    });
    expect(malformed.status).toBe(400);
    const refusal = (await malformed.json()) as { error?: string };
    expect(refusal.error).toContain("not valid JSON");
    expect(refusal.error).toContain("cctl spec plan preview native-sdd");

    const empty = await requestLegacyPreview("approved");
    expect(empty.status).toBe(200);
    const full = (await empty.json()) as { totalContextCount: number };
    expect(full.totalContextCount).toBe(2);
  });

  it("keeps the legacy projection deterministic, bounded, and evidence-explicit", async () => {
    const first = await readLegacyPreview();
    const second = await readLegacyPreview();
    expect(first.response.status).toBe(200);
    expect(first.preview).toEqual(second.preview);
    const preview = first.preview;
    const wide = preview.contexts.find(
      (context) => context.contextId === "context-task-1",
    );
    expect(preview.briefLimit).toBe(20);
    expect(wide?.totalBriefCount).toBe(22);
    expect(wide?.shownBriefCount).toBe(20);
    expect(wide?.omittedBriefCount).toBe(2);
    expect(wide?.criterionBriefs).toHaveLength(20);
    expect(preview.contexts.map((context) => context.contextId)).toEqual(
      [...preview.contexts.map((context) => context.contextId)].sort(),
    );
    const evidence = wide?.criterionBriefs.find(
      (brief) => brief.criterionElementId === "criterion-wide-1",
    )?.evidence;
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "commit",
        producer: "graph-workflow-lane-commit",
      }),
      expect.objectContaining({
        kind: "test_run",
        producer: "graph-workflow-validation-result",
      }),
    ]);
  });

  it("keeps the route's complete-context compatibility filter", async () => {
    const { response, preview } = await readLegacyPreview("approved", {
      contextId: "context-task-1",
    });
    expect(response.status).toBe(200);
    expect(preview.totalContextCount).toBe(2);
    expect(preview.shownContextCount).toBe(1);
    expect(preview.contexts).toHaveLength(1);
    expect(preview.contexts[0]?.shownBriefCount).toBe(22);
    expect(preview.contexts[0]?.omittedBriefCount).toBe(0);
  });

  it("refuses an unknown compatibility context and names the known ids", async () => {
    const response = await requestLegacyPreview("approved", {
      body: { contextId: "context-nope" },
    });
    expect(response.status).toBe(422);
    const refusal = JSON.stringify(await response.json());
    expect(refusal).toContain("context-task-1");
    expect(refusal).toContain("Re-run without --context");
  });

  it("keeps decoding a legacy execution scope at the compatibility route", async () => {
    const narrowed: ExecutionScope = {
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: WIDE_CRITERION_IDS,
      exclusionDispositions: [
        { criterionId: "criterion-verb", disposition: "deferred" },
      ],
    };
    const { response, preview } = await readLegacyPreview("approved", {
      scope: narrowed,
    });
    expect(response.status).toBe(200);
    expect(preview.totalContextCount).toBe(1);
    expect(preview.criterionCount).toBe(WIDE_CRITERION_IDS.length);
    expect(preview.scopeHash).toBe(hashExecutionScope(narrowed));
  });

  it("reports an uncompilable compatibility scope instead of widening it", async () => {
    const response = await requestLegacyPreview("approved", {
      body: {
        scope: {
          selectedTaskIds: ["task-2"],
          selectedCriterionIds: ["criterion-verb"],
          exclusionDispositions: [],
        },
      },
    });
    expect(response.status).toBe(422);
    const output = JSON.stringify(await response.json());
    expect(output).toContain(
      "dependency task-1 is outside the validated scope",
    );
    expect(output).toContain("re-run cctl spec plan preview native-sdd");
  });
});
