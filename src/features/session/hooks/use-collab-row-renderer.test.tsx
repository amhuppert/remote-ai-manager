// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { isValidElement } from "react";
import { useCollabRowRenderer } from "./use-collab-row-renderer";

describe("useCollabRowRenderer", () => {
  it("returns null when no collab passage props are provided", () => {
    const { result } = renderHook(() =>
      useCollabRowRenderer({
        collabPassageProps: null,
        collabEnvelopeForConversation: undefined,
        isCollabRunning: false,
        collabPinnedTopTarget: null,
        setCollabRowEl: () => {},
        handleCollabStop: () => {},
        handleCollabRefClick: () => {},
        projectName: "p",
        sessionName: "s",
        conversationId: "c",
        collabUserAnswerDrafts: {},
        setCollabUserAnswerDraft: () => {},
        clearCollabUserAnswerDrafts: () => {},
        collabResumeMutation: { isPending: false, mutate: () => {} },
      }),
    );
    const out = result.current({
      row: { kind: "collab", workflowId: "wf-1" },
    });
    expect(out).toBeNull();
  });

  it("renders a JSX element when collab passage props are present", () => {
    const passageProps = {
      workflowId: "wf-1",
      status: "running" as const,
      phase: "negotiation",
      featureSnapshot: {},
      artifacts: [],
    };
    const envelope = {
      workflowId: "wf-1",
      status: "running" as const,
      phase: "negotiation",
      featureSnapshot: {},
    };
    const { result } = renderHook(() =>
      useCollabRowRenderer({
        collabPassageProps: passageProps as never,
        collabEnvelopeForConversation: envelope,
        isCollabRunning: true,
        collabPinnedTopTarget: null,
        setCollabRowEl: () => {},
        handleCollabStop: () => {},
        handleCollabRefClick: () => {},
        projectName: "p",
        sessionName: "s",
        conversationId: "c",
        collabUserAnswerDrafts: {},
        setCollabUserAnswerDraft: () => {},
        clearCollabUserAnswerDrafts: () => {},
        collabResumeMutation: { isPending: false, mutate: () => {} },
      }),
    );
    const out = result.current({
      row: { kind: "collab", workflowId: "wf-1" },
    });
    expect(isValidElement(out)).toBe(true);
  });
});
