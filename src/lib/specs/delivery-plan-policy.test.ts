import { describe, expect, it } from "vitest";
import {
  deliveryPlanDocumentSchema,
  postLaunchPathsSentence,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  decideDeliveryPlanTransition,
  DeliveryPlanReaffirmationStateError,
  DeliveryPlanStatusConflictError,
  reaffirmDeliveryPlanCriteria,
  requireEditableDeliveryPlanDraft,
  requireReopenableDeliveryPlan,
  type DeliveryPlanTransition,
} from "./delivery-plan-policy";
import type { DeliveryPlanAttemptStatus } from "./schemas";

const statuses: readonly DeliveryPlanAttemptStatus[] = [
  "draft",
  "approved",
  "parked",
  "launched",
  "abandoned",
];
const candidate = { candidateId: "candidate", candidateHash: "hash" };
const input = {
  occurredAt: "2026-09-28T19:00:00.000Z",
  actor: { kind: "human" } as const,
};
const openRemedy = "Open a fresh attempt with `cctl spec plan open`.";
const parkRemedy =
  "Only a signed-off attempt can be parked for prelaunch review. Sign off the draft first.";
const launchRemedy =
  "Only a signed-off candidate launches. Sign off the draft first.";

function expectStatusConflict(
  act: () => unknown,
  status: DeliveryPlanAttemptStatus,
  remedy: string,
): void {
  expect(act).toThrow(DeliveryPlanStatusConflictError);
  expect(act).toThrow(
    `delivery plan attempt attempt is ${status}. Nothing was written. ${remedy}`,
  );
}

describe("delivery-plan transition policy", () => {
  it.each(statuses)("parks only approved attempts from %s", (status) => {
    const transition: DeliveryPlanTransition = {
      kind: "park",
      reason: "Review before launch",
      ...candidate,
    };
    // Parking requires the approved status; launch separately requires approval.
    const decide = () =>
      decideDeliveryPlanTransition(
        { attemptId: "attempt", status, hasApproval: false },
        { ...input, transition },
      );
    if (status !== "approved") {
      expectStatusConflict(decide, status, parkRemedy);
      return;
    }
    expect(decide()).toEqual({
      status: "parked",
      prelaunch: {
        parkedAt: input.occurredAt,
        parkedBy: input.actor,
        reason: transition.reason,
        candidate,
      },
    });
  });

  it.each(
    statuses.flatMap((status) => [
      { status, hasApproval: true },
      { status, hasApproval: false },
    ]),
  )("launches from $status with approval=$hasApproval", (attempt) => {
    const decide = () =>
      decideDeliveryPlanTransition(
        { attemptId: "attempt", ...attempt },
        {
          ...input,
          transition: {
            kind: "launch",
            executionId: "execution",
            ...candidate,
          },
        },
      );
    if (
      (attempt.status === "approved" || attempt.status === "parked") &&
      attempt.hasApproval
    ) {
      expect(decide()).toEqual({
        status: "launched",
        executionId: "execution",
      });
      return;
    }
    expectStatusConflict(
      decide,
      attempt.status,
      attempt.status === "launched" || attempt.status === "abandoned"
        ? openRemedy
        : launchRemedy,
    );
  });

  it.each(statuses)("abandons an attempt from %s", (status) => {
    const decide = () =>
      decideDeliveryPlanTransition(
        { attemptId: "attempt", status, hasApproval: false },
        { ...input, transition: { kind: "abandon", reason: "Superseded" } },
      );
    if (status === "abandoned") {
      expectStatusConflict(decide, status, openRemedy);
      return;
    }
    expect(decide()).toEqual({ status: "abandoned" });
  });

  it("preserves a nullable parking reason and validates prelaunch content", () => {
    const attempt = {
      attemptId: "attempt",
      status: "approved",
      hasApproval: true,
    } as const;
    expect(
      decideDeliveryPlanTransition(attempt, {
        ...input,
        transition: { kind: "park", reason: null, ...candidate },
      }),
    ).toMatchObject({ prelaunch: { reason: null } });
    expect(() =>
      decideDeliveryPlanTransition(attempt, {
        ...input,
        transition: { kind: "park", reason: "x".repeat(2001), ...candidate },
      }),
    ).toThrow(/2000/);
  });
});

describe("delivery-plan editing eligibility", () => {
  it.each(
    statuses.flatMap((status) => [
      { status, launchedExecutionId: null },
      { status, launchedExecutionId: "execution" },
    ]),
  )(
    "checks edits from $status with execution=$launchedExecutionId",
    (state) => {
      const act = () =>
        requireEditableDeliveryPlanDraft({ attemptId: "attempt", ...state });
      if (state.status === "draft") {
        expect(act).not.toThrow();
        return;
      }
      expectStatusConflict(
        act,
        state.status,
        state.status === "launched" && state.launchedExecutionId !== null
          ? postLaunchPathsSentence({})
          : state.status === "abandoned"
            ? openRemedy
            : "Return it to draft with `cctl spec plan reopen` before editing it.",
      );
    },
  );

  it.each(
    statuses.flatMap((status) =>
      [3, 4].flatMap((schemaVersion) => [
        { status, schemaVersion, launchedExecutionId: null },
        { status, schemaVersion, launchedExecutionId: "execution" },
      ]),
    ),
  )(
    "checks reopening $status v$schemaVersion with execution=$launchedExecutionId",
    (state) => {
      const schemaVersion = state.schemaVersion === 3 ? 3 : 4;
      const act = () =>
        requireReopenableDeliveryPlan(
          { attemptId: "attempt", ...state },
          schemaVersion,
        );
      if (state.status === "draft" && schemaVersion === 4) {
        expectStatusConflict(
          act,
          state.status,
          "There is nothing to reopen. Author the graph with `cctl workflow replace <id> --file <plan.json>`.",
        );
      } else if (
        state.status === "launched" &&
        state.launchedExecutionId !== null
      ) {
        expectStatusConflict(act, state.status, postLaunchPathsSentence({}));
      } else if (state.status === "abandoned") {
        expectStatusConflict(act, state.status, openRemedy);
      } else {
        expect(act).not.toThrow();
      }
    },
  );
});

describe("delivery-plan reaffirmation policy", () => {
  function document(): DeliveryPlanDocument {
    return deliveryPlanDocumentSchema.parse({
      schemaVersion: 4,
      binding: {
        dispositions: [
          {
            criterionElementId: "pending",
            disposition: "pending_reaffirmation",
            deliveredByExecutionId: "earlier-execution",
          },
          {
            criterionElementId: "included",
            disposition: "in_scope",
            deliveredByExecutionId: null,
          },
        ],
      },
    });
  }

  it("reaffirms requested criteria without mutating the draft or other dispositions", () => {
    const draft = document();
    const original = structuredClone(draft);
    expect(
      reaffirmDeliveryPlanCriteria("attempt", draft, ["pending", "pending"]),
    ).toEqual({
      ...draft,
      binding: {
        dispositions: [
          {
            criterionElementId: "pending",
            disposition: "reaffirmed",
            deliveredByExecutionId: "earlier-execution",
          },
          {
            criterionElementId: "included",
            disposition: "in_scope",
            deliveredByExecutionId: null,
          },
        ],
      },
    });
    expect(draft).toEqual(original);
  });

  it.each(["missing", "included"])(
    "refuses the whole batch when %s is not pending",
    (criterion) => {
      const draft = document();
      const original = structuredClone(draft);
      expect(() =>
        reaffirmDeliveryPlanCriteria("attempt", draft, ["pending", criterion]),
      ).toThrow(new DeliveryPlanReaffirmationStateError("attempt", criterion));
      expect(draft).toEqual(original);
    },
  );
});
