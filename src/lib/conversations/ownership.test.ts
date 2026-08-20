import { describe, expect, it } from "vitest";
import {
  decideOwnershipReclaim,
  decideTurnAdmission,
  type ConversationOwnershipFacts,
} from "./ownership";

const WORKFLOW = "wf-collab-1";

function facts(
  overrides: Partial<ConversationOwnershipFacts> = {},
): ConversationOwnershipFacts {
  return { owner: null, turnGeneration: 4, ...overrides };
}

const heldByUs = {
  kind: "collaboration" as const,
  workflowId: WORKFLOW,
  attemptEpoch: 1,
};

describe("decideTurnAdmission", () => {
  it("admits a prompt into a free conversation and moves the generation", () => {
    expect(decideTurnAdmission(facts())).toEqual({
      kind: "admit",
      turnGeneration: 5,
    });
  });

  it("refuses a prompt while a collaboration holds the conversation", () => {
    const decision = decideTurnAdmission(facts({ owner: heldByUs }));
    expect(decision).toEqual({ kind: "refuse", owner: heldByUs });
  });
});

describe("decideOwnershipReclaim", () => {
  const request = { workflowId: WORKFLOW, claimedTurnGeneration: 4 };

  // A restart kills the run without releasing, so the claim is still on the
  // record. This is the ticket's headline case and it must not depend on the
  // conversation's status, which nothing repairs after a crash.
  it("reclaims when this workflow is still the recorded owner", () => {
    expect(decideOwnershipReclaim(facts({ owner: heldByUs }), request)).toEqual(
      { kind: "claim", reason: "still_owner" },
    );
  });

  it("reclaims a released conversation when no turn has intervened", () => {
    expect(
      decideOwnershipReclaim(facts({ turnGeneration: 4 }), request),
    ).toEqual({ kind: "claim", reason: "free_and_unchanged" });
  });

  // The case the prompt-count heuristic could not see: the user finished a
  // whole turn after the collaboration failed. Admission moved the generation,
  // so the evidence survives even though the conversation is idle again.
  it("refuses when a turn was admitted since the claim", () => {
    const decision = decideOwnershipReclaim(
      facts({ turnGeneration: 5 }),
      request,
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      reason: "turn_intervened",
    });
  });

  it("refuses when another workflow holds the conversation", () => {
    const decision = decideOwnershipReclaim(
      facts({ owner: { ...heldByUs, workflowId: "wf-other" } }),
      request,
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      reason: "owned_by_other",
    });
  });

  // A prompt that died mid-turn leaves the conversation free with an ALREADY
  // incremented generation. Under the old status+count heuristic this was
  // indistinguishable from a dead collaboration; here it simply fails the
  // generation check.
  it("does not mistake a dead ordinary prompt for its own orphaned claim", () => {
    const afterAdmittedPrompt = decideTurnAdmission(
      facts({ turnGeneration: 4 }),
    );
    if (afterAdmittedPrompt.kind !== "admit") throw new Error("expected admit");

    const decision = decideOwnershipReclaim(
      facts({
        owner: null,
        turnGeneration: afterAdmittedPrompt.turnGeneration,
      }),
      request,
    );
    expect(decision.kind).toBe("refuse");
  });

  // An owner still on the record wins regardless of generation: the run never
  // released, so nothing else can have been admitted.
  it("reclaims its own stale claim even if the generation has moved", () => {
    expect(
      decideOwnershipReclaim(
        facts({ owner: heldByUs, turnGeneration: 99 }),
        request,
      ),
    ).toEqual({ kind: "claim", reason: "still_owner" });
  });
});
