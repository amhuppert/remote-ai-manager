import { describe, expect, it } from "vitest";

import { admitAuthoredWorkflowLaunch } from "@/lib/workflow-graph/authored-launch-admission";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import {
  canonicalDeliveryPlanCandidateBytes,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanDocumentSchema,
  type DeliveryPlanCandidateRecord,
} from "./delivery-plan";
import { finalizeDeliveryPlanLaunch } from "./delivery-plan-finalization";
import {
  deliveryPlanCandidateHash,
  deliveryPlanCandidateHashFromBytes,
} from "./delivery-plan-hash";

function candidate(): DeliveryPlanCandidateRecord {
  const launch = finalizeDeliveryPlanLaunch({
    specId: "spec-candidate",
    specSlug: "candidate-spec",
    attemptId: "attempt-candidate",
    candidateId: "candidate-one",
    launch: createMaximalAuthoredWorkflowLaunchFixture(),
  });
  return deliveryPlanCandidateRecordSchema.parse({
    protocol: "native-sdd-delivery-candidate/v2",
    schemaVersion: 2,
    specId: "spec-candidate",
    attemptId: "attempt-candidate",
    candidateId: "candidate-one",
    pinnedRevisionId: "revision-candidate",
    draftRevision: 7,
    document: {
      schemaVersion: 2,
      launch,
      binding: {
        dispositions: [
          {
            criterionElementId: "criterion-one",
            disposition: "in_scope",
            deliveredByExecutionId: null,
          },
        ],
        claims: [
          {
            contextId: "context-integrate",
            criterionElementIds: ["criterion-one"],
          },
        ],
      },
    },
  });
}

describe("canonical delivery-plan candidate", () => {
  it("writes one deterministic protocol-v2 record and hashes exactly its canonical bytes", () => {
    const record = candidate();
    const reordered = deliveryPlanCandidateRecordSchema.parse({
      document: record.document,
      draftRevision: record.draftRevision,
      pinnedRevisionId: record.pinnedRevisionId,
      candidateId: record.candidateId,
      attemptId: record.attemptId,
      specId: record.specId,
      schemaVersion: record.schemaVersion,
      protocol: record.protocol,
    });

    expect(canonicalDeliveryPlanCandidateBytes(record)).toBe(
      canonicalDeliveryPlanCandidateBytes(reordered),
    );
    expect(deliveryPlanCandidateHash(record)).toBe(
      deliveryPlanCandidateHash(reordered),
    );
    expect(
      deliveryPlanCandidateHashFromBytes(
        canonicalDeliveryPlanCandidateBytes(record),
      ),
    ).toBe(deliveryPlanCandidateHash(record));
    expect(deliveryPlanCandidateHash(record)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(record).not.toHaveProperty("compiledHash");
    expect(record.document.launch.definition.origin?.sourceUri).toContain(
      "/candidates/candidate-one",
    );
    expect(record.document.launch.definition.origin?.sourceUri).not.toContain(
      deliveryPlanCandidateHash(record),
    );
  });

  it.each([
    [
      "protocol",
      (value: Record<string, unknown>) => (value.protocol = "other"),
    ],
    [
      "schema version",
      (value: Record<string, unknown>) => (value.schemaVersion = 3),
    ],
    [
      "spec id",
      (value: Record<string, unknown>) => (value.specId = "spec-other"),
    ],
    [
      "attempt id",
      (value: Record<string, unknown>) => (value.attemptId = "attempt-other"),
    ],
    [
      "candidate id",
      (value: Record<string, unknown>) =>
        (value.candidateId = "candidate-other"),
    ],
    [
      "pinned revision",
      (value: Record<string, unknown>) =>
        (value.pinnedRevisionId = "revision-other"),
    ],
    [
      "draft revision",
      (value: Record<string, unknown>) => (value.draftRevision = 8),
    ],
    [
      "launch",
      (value: Record<string, unknown>) => {
        const document =
          value.document as DeliveryPlanCandidateRecord["document"];
        document.launch.name = "Mutated launch";
      },
    ],
    [
      "binding",
      (value: Record<string, unknown>) => {
        const document =
          value.document as DeliveryPlanCandidateRecord["document"];
        document.binding.claims[0]!.contextId = "context-other";
      },
    ],
    [
      "layout",
      (value: Record<string, unknown>) => {
        const document =
          value.document as DeliveryPlanCandidateRecord["document"];
        document.launch.layout.viewport.x += 1;
      },
    ],
    [
      "sources",
      (value: Record<string, unknown>) => {
        const document =
          value.document as DeliveryPlanCandidateRecord["document"];
        document.launch.definition.charter.sourcesOfTruth[0]!.label =
          "Mutated source";
      },
    ],
    [
      "locks",
      (value: Record<string, unknown>) => {
        const document =
          value.document as DeliveryPlanCandidateRecord["document"];
        document.launch.definition.lockedRegions![0]!.reason = "Mutated lock";
      },
    ],
  ])(
    "changes the candidate hash after a signed %s mutation",
    (_label, mutate) => {
      const record = candidate();
      const changed = structuredClone(record) as unknown as Record<
        string,
        unknown
      >;
      mutate(changed);

      expect(
        deliveryPlanCandidateHash(
          changed as unknown as DeliveryPlanCandidateRecord,
        ),
      ).not.toBe(deliveryPlanCandidateHash(record));
    },
  );

  it("admits the maximal finalized launch identically for ordinary and spec callers", async () => {
    const launch = candidate().document.launch;
    const [ordinary, specProposal] = await Promise.all([
      admitAuthoredWorkflowLaunch(launch, {
        caller: "project-create",
        documentScope: { kind: "project", projectPath: "/repo" },
        workflowDefaults: undefined,
      }),
      admitAuthoredWorkflowLaunch(launch, {
        caller: "spec-proposal",
        documentScope: { kind: "project", projectPath: "/repo" },
        workflowDefaults: undefined,
      }),
    ]);

    expect(ordinary.ok, JSON.stringify(ordinary)).toBe(true);
    expect(specProposal.ok, JSON.stringify(specProposal)).toBe(true);
    if (!ordinary.ok || !specProposal.ok) return;
    expect(specProposal).toEqual(ordinary);
  });

  it("authors acceptance criteria as records or prose and canonicalizes on the propose path exactly like a graph plan", async () => {
    const authored = createMaximalAuthoredWorkflowLaunchFixture();
    // The fixture is a finalized launch; the authored dialect reserves these
    // for server finalization, so an author's document omits them.
    const {
      origin: _origin,
      lockedRegions: _lockedRegions,
      approvalRequired: _approvalRequired,
      ...authoredDefinition
    } = authored.definition;
    const mixedLaunch = {
      ...authored,
      definition: {
        ...authoredDefinition,
        executionContexts: authored.definition.executionContexts.map(
          (context) =>
            context.id === "context-integrate"
              ? {
                  ...context,
                  acceptanceCriteria: [
                    {
                      id: "integrate-selected-work",
                      statement: "All selected work is integrated.",
                    },
                    {
                      id: "integrate-audit-trail",
                      statement: "The integration leaves an audit trail.",
                    },
                  ],
                }
              : context,
        ),
      },
    };

    // The direct-authored dialect (the schema `plan edit` bodies parse)
    // accepts the records shape alongside the untouched prose contexts.
    const document = deliveryPlanDocumentSchema.parse({
      schemaVersion: 2,
      launch: mixedLaunch,
      binding: {
        dispositions: [
          {
            criterionElementId: "criterion-one",
            disposition: "in_scope",
            deliveredByExecutionId: null,
          },
        ],
        claims: [
          {
            contextId: "context-integrate",
            criterionElementIds: ["criterion-one"],
          },
        ],
      },
    });

    const admitted = await admitAuthoredWorkflowLaunch(
      finalizeDeliveryPlanLaunch({
        specId: "spec-candidate",
        specSlug: "candidate-spec",
        attemptId: "attempt-candidate",
        candidateId: "candidate-one",
        launch: document.launch,
      }),
      {
        caller: "spec-proposal",
        documentScope: { kind: "project", projectPath: "/repo" },
        workflowDefaults: undefined,
      },
    );

    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    if (!admitted.ok) return;
    expect(
      admitted.launch.definition.executionContexts.map((context) => [
        context.id,
        context.acceptanceCriteria,
      ]),
    ).toEqual(
      document.launch.definition.executionContexts.map((context) => [
        context.id,
        criterionRecordsOf(context.acceptanceCriteria),
      ]),
    );
  });
});
