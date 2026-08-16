import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";

function directPlanDocument(authored: AuthoredSpineSpec): DeliveryPlanDocument {
  const launch = createWorkflowDefinitionRecord();
  return deliveryPlanDocumentSchema.parse({
    schemaVersion: 2,
    launch: {
      name: "Agent-authored spine graph",
      description: "The direct launch preserves this authored canvas.",
      definition: launch.definition,
      layout: {
        workflowId: "spine-activation-boundary",
        contextPositions: {},
      },
    },
    binding: {
      dispositions: [
        {
          criterionElementId: authored.criterionOneId,
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: authored.criterionTwoId,
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: [
            authored.criterionOneId,
            authored.criterionTwoId,
          ],
        },
      ],
    },
  });
}

describe("direct-authored delivery-plan lifecycle", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
    world = createSpecSpineWorld();
  });

  afterEach(() => {
    _resetPublicationForTesting();
  });

  it("opens and edits a version-2 attempt through production routes", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);

    const opened = await world.postAction(
      SLUG,
      "plan-open",
      { seedFromLast: false },
      "agent",
    );
    const openedPayload = (await opened.json()) as {
      attempt?: { status?: string; draftRevision?: number };
    };
    expect(opened.status, JSON.stringify(openedPayload)).toBe(200);
    expect(openedPayload).toMatchObject({
      attempt: { status: "draft", draftRevision: 1 },
    });

    const edited = await world.postAction(
      SLUG,
      "plan-edit",
      {
        expectedDraftRevision: 1,
        document: directPlanDocument(authored),
      },
      "agent",
    );
    const editedPayload = (await edited.json()) as {
      attempt?: { status?: string; draftRevision?: number };
    };
    expect(edited.status, JSON.stringify(editedPayload)).toBe(200);
    expect(editedPayload.attempt).toMatchObject({
      status: "draft",
      draftRevision: 2,
    });
    expect(world.publishedSse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "spec-delivery-plan-changed",
          kind: "opened",
        }),
        expect.objectContaining({
          type: "spec-delivery-plan-changed",
          kind: "edited",
        }),
      ]),
    );

    expect(
      world.db
        .prepare("SELECT COUNT(*) AS total FROM spec_delivery_plan_attempts")
        .get(),
    ).toEqual({ total: 1 });
  });
});
