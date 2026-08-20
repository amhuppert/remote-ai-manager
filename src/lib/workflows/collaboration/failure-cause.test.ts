import { describe, expect, it } from "vitest";
import {
  collaborationFailureCauseSchema,
  collaborationFailureClass,
  type CollaborationFailureCause,
} from "./failure-cause";

describe("collaborationFailureClass", () => {
  it("classifies a transient backend outage as operational", () => {
    expect(
      collaborationFailureClass({
        kind: "agent_call",
        failureKind: "backend_error",
        retryable: true,
      }),
    ).toBe("operational");
  });

  // The whole point of the ticket: a model outage mid-run must not discard the
  // work. `retryable` answers "is re-dispatching this call right now safe",
  // which is a different question from "may the user resume after the outage
  // passes" — quota and timeout say no to the first and yes to the second.
  it.each([["quota_exhausted"], ["timeout"], ["session_died"]] as const)(
    "classifies %s as operational even when the backend says retryable: false",
    (failureKind) => {
      expect(
        collaborationFailureClass({
          kind: "agent_call",
          failureKind,
          retryable: false,
        }),
      ).toBe("operational");
    },
  );

  it.each([
    [{ kind: "structured_output" }, "operational"],
    [{ kind: "artifact_files" }, "operational"],
    [{ kind: "process_restart" }, "operational"],
    [{ kind: "unhandled" }, "operational"],
    [{ kind: "policy_fail" }, "terminal"],
    [{ kind: "ledger_unusable", code: "duplicate_step" }, "terminal"],
    [{ kind: "missing_premise", detail: "agents" }, "terminal"],
    [{ kind: "user_stopped" }, "terminal"],
  ] as [CollaborationFailureCause, string][])(
    "classifies %o as %s",
    (cause, expected) => {
      expect(collaborationFailureClass(cause)).toBe(expected);
    },
  );

  // A run whose resolution decision chose `fail` would replay that same
  // recorded decision and fail again with no live step, forever.
  it("never offers resume for a semantic policy failure", () => {
    expect(collaborationFailureClass({ kind: "policy_fail" })).toBe("terminal");
  });
});

describe("collaborationFailureCauseSchema", () => {
  it("round-trips a persisted agent_call cause with its classifier detail", () => {
    const cause: CollaborationFailureCause = {
      kind: "agent_call",
      failureKind: "quota_exhausted",
      retryable: false,
      retryAfterHint: "try again in 5 minutes",
    };
    expect(
      collaborationFailureCauseSchema.parse(JSON.parse(JSON.stringify(cause))),
    ).toEqual(cause);
  });

  it("rejects an unknown cause kind rather than defaulting it", () => {
    expect(
      collaborationFailureCauseSchema.safeParse({ kind: "something_new" })
        .success,
    ).toBe(false);
  });
});
