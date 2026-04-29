/**
 * Tests for the Collaboration UI store.
 *
 * The store only holds ephemeral UI drafts (brief, selected workflow, user
 * answer drafts) — it does not own any server state. These tests exercise
 * the per-session/per-workflow scoping so a draft for session A cannot
 * leak into session B.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useCollaborationStore } from "./collaboration.store";

afterEach(() => {
  useCollaborationStore.setState({
    briefDraftsBySession: {},
    selectedWorkflowIdBySession: {},
    userAnswerDraftsByWorkflow: {},
  });
});

describe("collaboration store — brief drafts", () => {
  it("stores a brief draft scoped to the project+session pair", () => {
    useCollaborationStore
      .getState()
      .setBriefDraft("proj", "sess-a", { brief: "design X" });

    expect(
      useCollaborationStore.getState().briefDraftsBySession["proj::sess-a"]
        ?.brief,
    ).toBe("design X");
    expect(
      useCollaborationStore.getState().briefDraftsBySession["proj::sess-b"],
    ).toBeUndefined();
  });

  it("merges patches into the existing draft, preserving other fields", () => {
    useCollaborationStore
      .getState()
      .setBriefDraft("proj", "sess-a", { brief: "design X" });
    useCollaborationStore
      .getState()
      .setBriefDraft("proj", "sess-a", { maxIterations: 6 });

    const draft =
      useCollaborationStore.getState().briefDraftsBySession["proj::sess-a"];
    expect(draft).toMatchObject({ brief: "design X", maxIterations: 6 });
  });

  it("clears a draft for one session without affecting others", () => {
    useCollaborationStore
      .getState()
      .setBriefDraft("proj", "sess-a", { brief: "A" });
    useCollaborationStore
      .getState()
      .setBriefDraft("proj", "sess-b", { brief: "B" });
    useCollaborationStore.getState().clearBriefDraft("proj", "sess-a");

    expect(
      useCollaborationStore.getState().briefDraftsBySession["proj::sess-a"],
    ).toBeUndefined();
    expect(
      useCollaborationStore.getState().briefDraftsBySession["proj::sess-b"]
        ?.brief,
    ).toBe("B");
  });
});

describe("collaboration store — selected workflow", () => {
  it("scopes selection per session", () => {
    useCollaborationStore
      .getState()
      .setSelectedWorkflowId("proj", "sess-a", "wf-1");
    useCollaborationStore
      .getState()
      .setSelectedWorkflowId("proj", "sess-b", "wf-2");

    expect(
      useCollaborationStore.getState().selectedWorkflowIdBySession[
        "proj::sess-a"
      ],
    ).toBe("wf-1");
    expect(
      useCollaborationStore.getState().selectedWorkflowIdBySession[
        "proj::sess-b"
      ],
    ).toBe("wf-2");
  });

  it("clears selection when set to null", () => {
    useCollaborationStore
      .getState()
      .setSelectedWorkflowId("proj", "sess-a", "wf-1");
    useCollaborationStore
      .getState()
      .setSelectedWorkflowId("proj", "sess-a", null);

    expect(
      useCollaborationStore.getState().selectedWorkflowIdBySession[
        "proj::sess-a"
      ],
    ).toBeNull();
  });
});

describe("collaboration store — user answer drafts", () => {
  it("scopes answers to (session, workflow)", () => {
    useCollaborationStore
      .getState()
      .setUserAnswerDraft("proj", "sess-a", "wf-1", "q1", "yes");
    useCollaborationStore
      .getState()
      .setUserAnswerDraft("proj", "sess-a", "wf-2", "q1", "no");

    const drafts = useCollaborationStore.getState().userAnswerDraftsByWorkflow;
    expect(drafts["proj::sess-a::wf-1"]).toEqual({ q1: "yes" });
    expect(drafts["proj::sess-a::wf-2"]).toEqual({ q1: "no" });
  });

  it("clears all answers for one workflow on submit", () => {
    useCollaborationStore
      .getState()
      .setUserAnswerDraft("proj", "sess-a", "wf-1", "q1", "yes");
    useCollaborationStore
      .getState()
      .setUserAnswerDraft("proj", "sess-a", "wf-1", "q2", "no");
    useCollaborationStore
      .getState()
      .clearUserAnswerDrafts("proj", "sess-a", "wf-1");

    const drafts = useCollaborationStore.getState().userAnswerDraftsByWorkflow;
    expect(drafts["proj::sess-a::wf-1"]).toBeUndefined();
  });
});
