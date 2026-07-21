import { beforeEach, describe, expect, it } from "vitest";

import { quickTicketBundleKeySchema } from "@/lib/tickets/schemas";
import {
  useQuickTicketStore,
  type QuickTicketStoreState,
} from "./quick-ticket.store";

const RESET_STATE: QuickTicketStoreState = {
  open: false,
  lifecycleRevision: 0,
  bugMode: false,
  draft: null,
  draftStashed: false,
  draftRestored: false,
  contextSnapshot: null,
  conversationRegistry: [],
};

beforeEach(() => {
  useQuickTicketStore.setState(RESET_STATE);
});

describe("quick-ticket store — open-time snapshot", () => {
  it("initializes a fresh draft from route and conversation context", () => {
    const store = useQuickTicketStore.getState();
    store.registerQuickTicketConversation({
      token: "conversation-owner",
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "conversation-1",
      title: "Implement quick ticket",
    });
    store.openQuickTicket({
      pathname: "/projects/command-center/quick-ticket",
    });

    expect(useQuickTicketStore.getState()).toMatchObject({
      open: true,
      bugMode: false,
      draftRestored: false,
      contextSnapshot: {
        projectName: "command-center",
        sessionName: "quick-ticket",
        conversation: {
          conversationId: "conversation-1",
          title: "Implement quick ticket",
        },
      },
      draft: {
        projectName: "command-center",
        workType: "feature",
        title: "",
        description: "",
        conversationAttached: true,
        removedBundleKeys: [],
        autoStart: false,
        kickoffBackend: null,
        kickoffModel: null,
        kickoffReasoningEffort: null,
      },
    });
  });

  it("stashes and restores the auto-start kickoff selection with the draft", () => {
    const store = useQuickTicketStore.getState();
    store.openQuickTicket({ pathname: "/projects/first" });
    store.updateQuickTicketDraft({
      autoStart: true,
      kickoffBackend: "codex",
      kickoffModel: "gpt-5.6-sol",
      kickoffReasoningEffort: "ultra",
    });
    store.closeQuickTicket({ stashDraft: true });
    store.openQuickTicket({ pathname: "/projects/second" });

    expect(useQuickTicketStore.getState().draft).toMatchObject({
      autoStart: true,
      kickoffBackend: "codex",
      kickoffModel: "gpt-5.6-sol",
      kickoffReasoningEffort: "ultra",
    });
  });

  it("does not change the snapshot while the dialog remains open", () => {
    const store = useQuickTicketStore.getState();
    store.openQuickTicket({ pathname: "/projects/first" });
    store.registerQuickTicketConversation({
      token: "late-owner",
      projectName: "second",
      sessionName: null,
      conversationId: "late-conversation",
      title: "Mounted later",
    });
    store.openQuickTicket({ pathname: "/projects/second" });

    expect(useQuickTicketStore.getState().contextSnapshot).toEqual({
      projectName: "first",
    });
    expect(useQuickTicketStore.getState().draft?.projectName).toBe("first");
  });

  it("restores a stashed draft with its original context after navigation", () => {
    const store = useQuickTicketStore.getState();
    store.openQuickTicket({ pathname: "/projects/first" });
    store.updateQuickTicketDraft({ title: "Keep this title" });
    store.closeQuickTicket({ stashDraft: true });
    store.openQuickTicket({ pathname: "/projects/second" });

    expect(useQuickTicketStore.getState()).toMatchObject({
      open: true,
      draftRestored: true,
      contextSnapshot: { projectName: "first" },
      draft: { projectName: "first", title: "Keep this title" },
    });
  });

  it("discards a restored draft into a fresh snapshot for the current route", () => {
    const store = useQuickTicketStore.getState();
    store.openQuickTicket({ pathname: "/projects/first" });
    store.updateQuickTicketDraft({ title: "Discard me" });
    store.closeQuickTicket({ stashDraft: true });
    store.openQuickTicket({ pathname: "/projects/second" });
    store.discardQuickTicketDraft({ pathname: "/projects/second" });

    expect(useQuickTicketStore.getState()).toMatchObject({
      open: true,
      draftRestored: false,
      contextSnapshot: { projectName: "second" },
      draft: { projectName: "second", title: "" },
    });
  });

  it("clears an unstashed draft and context when closing", () => {
    const store = useQuickTicketStore.getState();
    store.openQuickTicket({ pathname: "/projects/command-center" });
    store.setQuickTicketBugMode(true);
    store.closeQuickTicket({ stashDraft: false });

    expect(useQuickTicketStore.getState()).toMatchObject({
      open: false,
      bugMode: false,
      draft: null,
      contextSnapshot: null,
      draftStashed: false,
      draftRestored: false,
    });
  });
});

describe("quick-ticket store — owner-token registry", () => {
  it("unregisters only the matching owner and reveals an older registration", () => {
    const store = useQuickTicketStore.getState();
    store.registerQuickTicketConversation({
      token: "older-owner",
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "older-conversation",
      title: "Older",
    });
    store.registerQuickTicketConversation({
      token: "newer-owner",
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "newer-conversation",
      title: "Newer",
    });

    store.unregisterQuickTicketConversation("newer-owner");
    store.openQuickTicket({
      pathname: "/projects/command-center/quick-ticket",
    });

    expect(
      useQuickTicketStore.getState().contextSnapshot?.conversation
        ?.conversationId,
    ).toBe("older-conversation");
  });

  it("upserts a repeated owner token as the newest registration", () => {
    const store = useQuickTicketStore.getState();
    store.registerQuickTicketConversation({
      token: "strict-mode-owner",
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "first-render",
      title: "First render",
    });
    store.registerQuickTicketConversation({
      token: "other-owner",
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "other",
      title: "Other",
    });
    store.registerQuickTicketConversation({
      token: "strict-mode-owner",
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "second-render",
      title: "Second render",
    });

    const registry = useQuickTicketStore.getState().conversationRegistry;
    expect(registry).toHaveLength(2);
    expect(registry.at(-1)?.conversationId).toBe("second-render");
  });
});

describe("quick-ticket store — canonical diagnostic bundle keys", () => {
  it("removes each canonical key once and restores the complete bundle", () => {
    const store = useQuickTicketStore.getState();
    store.openQuickTicket({ pathname: "/tickets" });

    for (const key of quickTicketBundleKeySchema.options) {
      store.removeQuickTicketBundleKey(key);
      store.removeQuickTicketBundleKey(key);
    }

    expect(useQuickTicketStore.getState().draft?.removedBundleKeys).toEqual(
      quickTicketBundleKeySchema.options,
    );

    store.restoreQuickTicketBundleKeys();
    expect(useQuickTicketStore.getState().draft?.removedBundleKeys).toEqual([]);
  });
});
