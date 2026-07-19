import { describe, it, expect, beforeEach } from "vitest";
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import { useSessionDetailStore } from "./session-detail.store";
import { panelSessionKeyFor } from "./session-detail/types";

function resetStore() {
  useSessionDetailStore.getState().resetStore();
}

const SESSION_A = panelSessionKeyFor("proj", "sess-a");
const SESSION_B = panelSessionKeyFor("proj", "sess-b");

/** Put the side panel into a distinctive non-default configuration. */
function arrangePanelState() {
  const s = useSessionDetailStore.getState();
  s.switchRightPaneTab("alignment");
  s.openDocument({
    projectName: "proj",
    sessionName: "sess-a",
    docPath: "docs/plan.md",
    title: "Plan",
  });
  s.selectSpecFile("steering", "design.md");
  s.setPendingTrayExpanded(true);
}

describe("session-detail.store — side-panel persistence across conversations", () => {
  beforeEach(resetStore);

  it("resetConversationState preserves the side-panel state", () => {
    arrangePanelState();
    const before = useSessionDetailStore.getState();

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    // openDocument routed the tab to docs; the routed tab must survive.
    expect(after.rightPaneTab).toBe("docs");
    expect(after.openDocuments).toEqual(before.openDocuments);
    expect(after.activeDocPath).toBe("docs/plan.md");
    expect(after.docActivationNonce).toBe(before.docActivationNonce);
    expect(after.specBrowserSelection).toEqual({
      category: "steering",
      file: "design.md",
    });
    expect(after.pendingTrayExpanded).toBe(true);
  });

  it("resetConversationState still resets conversation-scoped state", () => {
    const s = useSessionDetailStore.getState();
    s.showPlaceholder("thinking…");
    s.showQuestions("q1", [
      askQuestionItemSchema.parse({
        id: "q1",
        question: "Which?",
        options: [],
      }),
    ]);

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    expect(after.promptPlaceholder).toBeNull();
    expect(after.pendingQuestions).toBeNull();
  });
});

describe("session-detail.store — activatePanelSession", () => {
  beforeEach(resetStore);

  it("re-activating the already-active session leaves the panel untouched", () => {
    useSessionDetailStore.getState().activatePanelSession(SESSION_A);
    arrangePanelState();
    const before = useSessionDetailStore.getState();

    useSessionDetailStore.getState().activatePanelSession(SESSION_A);

    const after = useSessionDetailStore.getState();
    expect(after.rightPaneTab).toBe(before.rightPaneTab);
    expect(after.openDocuments).toEqual(before.openDocuments);
    expect(after.activeDocPath).toBe(before.activeDocPath);
    expect(after.docActivationNonce).toBe(before.docActivationNonce);
  });

  it("switching to an unseen session presents the default panel", () => {
    useSessionDetailStore.getState().activatePanelSession(SESSION_A);
    arrangePanelState();

    useSessionDetailStore.getState().activatePanelSession(SESSION_B);

    const after = useSessionDetailStore.getState();
    expect(after.rightPaneTab).toBe("diff");
    expect(after.openDocuments).toEqual([]);
    expect(after.activeDocPath).toBeNull();
    expect(after.specBrowserSelection).toBeNull();
    expect(after.pendingTrayExpanded).toBe(false);
  });

  it("returning to a previous session restores its panel snapshot", () => {
    useSessionDetailStore.getState().activatePanelSession(SESSION_A);
    arrangePanelState();
    useSessionDetailStore.getState().switchRightPaneTab("alignment");

    useSessionDetailStore.getState().activatePanelSession(SESSION_B);
    useSessionDetailStore.getState().switchRightPaneTab("specs");
    const nonceBeforeReturn =
      useSessionDetailStore.getState().docActivationNonce;

    useSessionDetailStore.getState().activatePanelSession(SESSION_A);

    const restored = useSessionDetailStore.getState();
    expect(restored.rightPaneTab).toBe("alignment");
    expect(restored.openDocuments).toEqual([
      {
        projectName: "proj",
        sessionName: "sess-a",
        docPath: "docs/plan.md",
        title: "Plan",
      },
    ]);
    expect(restored.activeDocPath).toBe("docs/plan.md");
    expect(restored.specBrowserSelection).toEqual({
      category: "steering",
      file: "design.md",
    });
    expect(restored.pendingTrayExpanded).toBe(true);
    // A restored active document bumps the nonce so the viewer re-presents it
    // (breaks DocsPanel's browse latch and flashes the body).
    expect(restored.docActivationNonce).toBeGreaterThan(nonceBeforeReturn);

    // And session B's stash is intact for the round trip back.
    useSessionDetailStore.getState().activatePanelSession(SESSION_B);
    expect(useSessionDetailStore.getState().rightPaneTab).toBe("specs");
    expect(useSessionDetailStore.getState().openDocuments).toEqual([]);
  });

  it("restoring a session with no open document does not bump the nonce", () => {
    useSessionDetailStore.getState().activatePanelSession(SESSION_A);
    useSessionDetailStore.getState().switchRightPaneTab("specs");
    useSessionDetailStore.getState().activatePanelSession(SESSION_B);
    const nonceBefore = useSessionDetailStore.getState().docActivationNonce;

    useSessionDetailStore.getState().activatePanelSession(SESSION_A);

    expect(useSessionDetailStore.getState().docActivationNonce).toBe(
      nonceBefore,
    );
  });

  it("resetStore clears panel-session memory", () => {
    useSessionDetailStore.getState().activatePanelSession(SESSION_A);
    arrangePanelState();

    useSessionDetailStore.getState().resetStore();

    const after = useSessionDetailStore.getState();
    expect(after.panelSessionKey).toBeNull();
    expect(after.panelSessionMemory).toEqual({});

    // A later activation of session A finds nothing to restore.
    useSessionDetailStore.getState().activatePanelSession(SESSION_A);
    expect(useSessionDetailStore.getState().openDocuments).toEqual([]);
  });
});
