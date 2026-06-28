import { describe, it, expect, beforeEach } from "vitest";
import type { DocumentRef } from "@/lib/document-comments/schemas";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";
import { useSessionDetailStore } from "./session-detail.store";

function resetStore() {
  useSessionDetailStore.getState().resetStore();
}

function docRef(docPath: string, title = docPath): DocumentRef {
  return { projectName: "proj", sessionName: "sess", docPath, title };
}

const target: DocumentFeedbackTarget = {
  projectName: "proj",
  projectPath: "/repos/proj",
  sessionName: "sess",
  conversationId: "conv-1",
  backend: "claude",
  status: "awaiting",
};

describe("session-detail.store — document viewer slice", () => {
  beforeEach(resetStore);

  it("has the expected defaults", () => {
    const s = useSessionDetailStore.getState();
    expect(s.openDocuments).toEqual([]);
    expect(s.activeDocPath).toBeNull();
    expect(s.docActivationNonce).toBe(0);
    expect(s.pendingTrayExpanded).toBe(false);
    expect(s.feedbackTarget).toBeNull();
  });

  it("openDocument adds a tab, activates it, and routes to the docs surface", () => {
    const s = useSessionDetailStore.getState();
    s.openDocument(docRef("a.md"));

    const after = useSessionDetailStore.getState();
    expect(after.openDocuments.map((d) => d.docPath)).toEqual(["a.md"]);
    expect(after.activeDocPath).toBe("a.md");
    expect(after.docActivationNonce).toBe(1);
    expect(after.rightPaneTab).toBe("docs");
    expect(after.mobilePanel).toBe("docs");
  });

  it("openDocument leaves the panes layout so the viewer can show", () => {
    // The panes layout replaces the right pane (where the viewer lives) with a
    // full-width conversation grid, so opening a doc from a panes transcript
    // must drop out of panes — otherwise the viewer never mounts (req 4.3).
    const s = useSessionDetailStore.getState();
    s.switchLayout("panes", "cc-test-doc-layout");
    expect(useSessionDetailStore.getState().layout).toBe("panes");

    s.openDocument(docRef("a.md"));

    const after = useSessionDetailStore.getState();
    expect(after.layout).toBe("default");
    expect(after.activeDocPath).toBe("a.md");
    expect(after.rightPaneTab).toBe("docs");
  });

  it("openDocument leaves the conversation-only layout for split so the viewer can show", () => {
    // The conversation-only layout is a single full-width column with no right
    // pane, so opening a doc from a conversation-only transcript must switch to
    // the split 50/50 layout — otherwise the right pane never gets a column and
    // the viewer stays invisible (req 4.3).
    const s = useSessionDetailStore.getState();
    s.switchLayout("conversation", "cc-test-doc-layout");
    expect(useSessionDetailStore.getState().layout).toBe("conversation");

    s.openDocument(docRef("a.md"));

    const after = useSessionDetailStore.getState();
    expect(after.layout).toBe("split");
    expect(after.activeDocPath).toBe("a.md");
    expect(after.rightPaneTab).toBe("docs");
  });

  it("openDocument preserves a non-panes layout that already shows the viewer", () => {
    const s = useSessionDetailStore.getState();
    s.switchLayout("split", "cc-test-doc-layout");
    s.openDocument(docRef("a.md"));
    expect(useSessionDetailStore.getState().layout).toBe("split");
  });

  it("opening a second document adds a tab and activates it", () => {
    const s = useSessionDetailStore.getState();
    s.openDocument(docRef("a.md"));
    s.openDocument(docRef("b.md"));

    const after = useSessionDetailStore.getState();
    expect(after.openDocuments.map((d) => d.docPath)).toEqual(["a.md", "b.md"]);
    expect(after.activeDocPath).toBe("b.md");
    expect(after.docActivationNonce).toBe(2);
  });

  it("re-opening an already-open document does not duplicate but re-activates", () => {
    const s = useSessionDetailStore.getState();
    s.openDocument(docRef("a.md"));
    s.openDocument(docRef("b.md"));
    s.openDocument(docRef("a.md"));

    const after = useSessionDetailStore.getState();
    expect(after.openDocuments.map((d) => d.docPath)).toEqual(["a.md", "b.md"]);
    expect(after.activeDocPath).toBe("a.md");
    expect(after.docActivationNonce).toBe(3);
  });

  it("activateDocument activates an open tab and bumps the nonce; no-op for unknown", () => {
    const s = useSessionDetailStore.getState();
    s.openDocument(docRef("a.md"));
    s.openDocument(docRef("b.md"));

    s.activateDocument("a.md");
    let after = useSessionDetailStore.getState();
    expect(after.activeDocPath).toBe("a.md");
    expect(after.docActivationNonce).toBe(3);

    s.activateDocument("missing.md");
    after = useSessionDetailStore.getState();
    expect(after.activeDocPath).toBe("a.md");
    expect(after.docActivationNonce).toBe(3);
  });

  it("closeDocument removes a tab and activates a neighbor when the active one closes", () => {
    const s = useSessionDetailStore.getState();
    s.openDocument(docRef("a.md"));
    s.openDocument(docRef("b.md"));
    s.openDocument(docRef("c.md"));
    // active is c.md
    s.closeDocument("c.md");
    let after = useSessionDetailStore.getState();
    expect(after.openDocuments.map((d) => d.docPath)).toEqual(["a.md", "b.md"]);
    expect(after.activeDocPath).toBe("b.md");

    // closing a non-active tab keeps the active one
    s.closeDocument("a.md");
    after = useSessionDetailStore.getState();
    expect(after.openDocuments.map((d) => d.docPath)).toEqual(["b.md"]);
    expect(after.activeDocPath).toBe("b.md");

    // closing the last tab clears the active path
    s.closeDocument("b.md");
    after = useSessionDetailStore.getState();
    expect(after.openDocuments).toEqual([]);
    expect(after.activeDocPath).toBeNull();
  });

  it("setPendingTrayExpanded and togglePendingTray control the tray", () => {
    const s = useSessionDetailStore.getState();
    s.setPendingTrayExpanded(true);
    expect(useSessionDetailStore.getState().pendingTrayExpanded).toBe(true);
    s.togglePendingTray();
    expect(useSessionDetailStore.getState().pendingTrayExpanded).toBe(false);
  });

  it("setFeedbackTarget stores the chosen target", () => {
    const s = useSessionDetailStore.getState();
    s.setFeedbackTarget(target);
    expect(useSessionDetailStore.getState().feedbackTarget).toEqual(target);
  });

  it("resetStore restores the document viewer slice defaults", () => {
    const s = useSessionDetailStore.getState();
    s.openDocument(docRef("a.md"));
    s.setFeedbackTarget(target);
    s.setPendingTrayExpanded(true);

    s.resetStore();

    const after = useSessionDetailStore.getState();
    expect(after.openDocuments).toEqual([]);
    expect(after.activeDocPath).toBeNull();
    expect(after.feedbackTarget).toBeNull();
    expect(after.pendingTrayExpanded).toBe(false);
  });
});
