/** Coordinates trusted agents against session membership and current lane bindings. */
import { describe, expect, it } from "vitest";
import {
  authorizeExecutionMutation,
  authorizeWorkflowLaunch,
  type PrincipalExecutionFacts,
} from "./request-principal";

const facts = (
  overrides?: Partial<PrincipalExecutionFacts>,
): PrincipalExecutionFacts => ({
  executionId: "exec-1",
  originConversationId: "origin-conv",
  originConversationExists: true,
  boundLaneConversationId: () => null,
  ...overrides,
});

describe("authorizeExecutionMutation", () => {
  it("admits the human UI regardless of which conversation launched the run", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "human_ui" },
        execution: facts({ originConversationId: "someone-elses-conv" }),
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits the immutable origin conversation", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "origin-conv" },
        execution: facts(),
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses a non-origin conversation and names the origin", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "sibling-conv" },
        execution: facts(),
      }),
    ).toEqual({
      kind: "refused",
      code: "non_origin_principal",
      originConversationId: "origin-conv",
    });
  });

  it("refuses every agent on an unowned run, which has no origin to match", () => {
    // An unowned run predates origin capture or was launched by the human UI.
    // Matching "null === null" would make every agent its origin.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "any-conv" },
        execution: facts({ originConversationId: null }),
      }),
    ).toEqual({
      kind: "refused",
      code: "non_origin_principal",
      originConversationId: null,
    });
  });

  it("refuses an agent whose origin conversation was deleted", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "successor-conv" },
        execution: facts({ originConversationId: "deleted-origin" }),
      }),
    ).toEqual({
      kind: "refused",
      code: "non_origin_principal",
      originConversationId: "deleted-origin",
    });
  });

  it("admits the execution's current lane", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          boundLaneConversationId: (contextId) =>
            contextId === "context-a" ? "lane-conv" : null,
        }),
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses the current lane when the execution's recorded origin was deleted", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          originConversationExists: false,
          boundLaneConversationId: () => "lane-conv",
        }),
      }),
    ).toEqual({
      kind: "refused",
      code: "origin_conversation_absent",
      originConversationId: "origin-conv",
    });
  });

  it("refuses a lane whose binding has moved on", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "retired-lane-conv",
        },
        execution: facts({
          boundLaneConversationId: () => "current-lane-conv",
        }),
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });

  it("refuses a lane identity scoped to a different execution", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "other-exec",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          boundLaneConversationId: () => "lane-conv",
        }),
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });
});

describe("authorizeExecutionMutation under any_session_conversation authority", () => {
  it("admits a conversation that did not launch the run", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "sibling-conv" },
        execution: facts(),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits a conversation on an unowned run", () => {
    // A run launched from the UI records no origin at all. Under the origin
    // rule that means no agent may act; under membership it means there is
    // simply no origin to compare against.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "any-conv" },
        execution: facts({ originConversationId: null }),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits a conversation whose run's recorded origin was deleted", () => {
    // The deleted-origin refusal exists to stop a successor inheriting the
    // vacancy under the origin rule. Membership inherits nothing, so the
    // vacancy is not a refusal here.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "successor-conv" },
        execution: facts({
          originConversationId: "deleted-origin",
          originConversationExists: false,
        }),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits the current lane of a run whose recorded origin was deleted", () => {
    // A lane's authority never came from the origin conversation; the deleted-
    // origin gate refused it only as collateral of the rule above.
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          originConversationExists: false,
          boundLaneConversationId: () => "lane-conv",
        }),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("still refuses a lane whose binding has moved on", () => {
    // Membership widens WHICH conversations may act, not whether a replaced
    // lane may keep acting on the context it no longer drives.
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "retired-lane-conv",
        },
        execution: facts({
          boundLaneConversationId: () => "current-lane-conv",
        }),
        authority: "any_session_conversation",
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });

  it("still refuses a lane identity scoped to a different execution", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "other-exec",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          boundLaneConversationId: () => "lane-conv",
        }),
        authority: "any_session_conversation",
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });
});

describe("authorizeWorkflowLaunch", () => {
  it("admits the human UI", () => {
    expect(authorizeWorkflowLaunch({ kind: "human_ui" })).toEqual({
      kind: "allowed",
    });
  });

  it("admits an ordinary conversation", () => {
    expect(
      authorizeWorkflowLaunch({
        kind: "conversation",
        conversationId: "origin-conv",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses a workflow lane as nesting, whatever the lease says", () => {
    expect(
      authorizeWorkflowLaunch({
        kind: "lane",
        executionId: "exec-1",
        contextId: "context-a",
        conversationId: "lane-conv",
      }),
    ).toEqual({ kind: "refused", code: "workflow_nesting_refused" });
  });
});
