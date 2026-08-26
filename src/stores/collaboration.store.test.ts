/**
 * Tests for the Collaboration UI store.
 *
 * The store only holds ephemeral UI drafts (user answer drafts when a paused
 * workflow needs input, and per-conversation /collab config drafts) — it does
 * not own any server state. These tests exercise the per-(session,workflow)
 * and per-conversation scoping so a draft for one scope cannot leak into
 * another.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAB_CONFIG_DRAFT,
  useCollaborationStore,
} from "./collaboration.store";

afterEach(() => {
  useCollaborationStore.setState({
    userAnswerDraftsByWorkflow: {},
    collabConfigDraftsByConversation: {},
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

describe("collaboration store — /collab config drafts", () => {
  it("scopes drafts per conversation", () => {
    useCollaborationStore
      .getState()
      .setCollabConfigDraft("proj", "sess-a", "conv-1", {
        ...DEFAULT_COLLAB_CONFIG_DRAFT,
        negotiationRounds: 5,
      });
    useCollaborationStore
      .getState()
      .setCollabConfigDraft("proj", "sess-a", "conv-2", {
        ...DEFAULT_COLLAB_CONFIG_DRAFT,
        agentTwo: {
          backend: "claude",
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        },
      });

    const drafts =
      useCollaborationStore.getState().collabConfigDraftsByConversation;
    expect(drafts["proj::sess-a::conv-1"]?.negotiationRounds).toBe(5);
    expect(drafts["proj::sess-a::conv-2"]?.agentTwo?.backend).toBe("claude");
  });

  it("clears a draft for one conversation without affecting others", () => {
    useCollaborationStore
      .getState()
      .setCollabConfigDraft("proj", "sess-a", "conv-1", {
        ...DEFAULT_COLLAB_CONFIG_DRAFT,
        negotiationRounds: 7,
      });
    useCollaborationStore
      .getState()
      .setCollabConfigDraft("proj", "sess-a", "conv-2", {
        ...DEFAULT_COLLAB_CONFIG_DRAFT,
        negotiationRounds: 9,
      });
    useCollaborationStore
      .getState()
      .clearCollabConfigDraft("proj", "sess-a", "conv-1");

    const drafts =
      useCollaborationStore.getState().collabConfigDraftsByConversation;
    expect(drafts["proj::sess-a::conv-1"]).toBeUndefined();
    expect(drafts["proj::sess-a::conv-2"]?.negotiationRounds).toBe(9);
  });
});
