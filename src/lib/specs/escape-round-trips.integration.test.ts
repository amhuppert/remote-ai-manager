import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";

import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";

function planBinding(authored: AuthoredSpineSpec): DeliveryPlanBinding {
  return {
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
  };
}

describe("managed workflow delivery-plan lifecycle", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
    world = createSpecSpineWorld();
  });

  afterEach(() => {
    _resetPublicationForTesting();
  });

  it("opens a managed definition and edits only its version-4 dispositions through production routes", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);

    const opened = await world.postAction(SLUG, "plan-open", {}, "agent");
    const openedPayload = (await opened.json()) as {
      attempt?: { status?: string; draftRevision?: number };
      workflowDefinition?: { id?: string; revision?: number };
    };
    expect(opened.status, JSON.stringify(openedPayload)).toBe(200);
    expect(openedPayload).toMatchObject({
      attempt: { status: "draft", draftRevision: 1 },
      workflowDefinition: { revision: 1 },
    });

    const edited = await world.postAction(
      SLUG,
      "plan-edit",
      {
        expectedDraftRevision: 1,
        binding: planBinding(authored),
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
