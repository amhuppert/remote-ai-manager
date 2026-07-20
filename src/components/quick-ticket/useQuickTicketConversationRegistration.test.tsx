// @vitest-environment jsdom

import { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { QuickTicketConversationRegistration } from "@/lib/tickets/quick-ticket-context";
import {
  useQuickTicketStore,
  type QuickTicketStoreState,
} from "@/stores/quick-ticket.store";
import { useQuickTicketConversationRegistration } from "./useQuickTicketConversationRegistration";

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

type Registration = Omit<QuickTicketConversationRegistration, "token">;

function Owner({ registration }: { registration: Registration }): null {
  useQuickTicketConversationRegistration(registration);
  return null;
}

beforeEach(() => {
  useQuickTicketStore.setState(RESET_STATE);
});

afterEach(() => {
  cleanup();
});

describe("useQuickTicketConversationRegistration", () => {
  it("survives StrictMode effects and reveals an older owner on newer-owner unmount", () => {
    const older: Registration = {
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversationId: "older-conversation",
      title: "Older conversation",
    };
    const newer: Registration = {
      ...older,
      conversationId: "newer-conversation",
      title: "Newer conversation",
    };
    const view = render(
      <StrictMode>
        <Owner key="older" registration={older} />
        <Owner key="newer" registration={newer} />
      </StrictMode>,
    );

    expect(useQuickTicketStore.getState().conversationRegistry).toHaveLength(2);
    useQuickTicketStore.getState().openQuickTicket({
      pathname: "/projects/command-center/quick-ticket",
    });
    expect(
      useQuickTicketStore.getState().contextSnapshot?.conversation
        ?.conversationId,
    ).toBe("newer-conversation");
    useQuickTicketStore.getState().clearQuickTicket();

    view.rerender(
      <StrictMode>
        <Owner key="older" registration={older} />
      </StrictMode>,
    );
    expect(useQuickTicketStore.getState().conversationRegistry).toHaveLength(1);
    useQuickTicketStore.getState().openQuickTicket({
      pathname: "/projects/command-center/quick-ticket",
    });
    expect(
      useQuickTicketStore.getState().contextSnapshot?.conversation
        ?.conversationId,
    ).toBe("older-conversation");

    view.unmount();
    expect(useQuickTicketStore.getState().conversationRegistry).toEqual([]);
  });

  it("replaces one owner's registration when its conversation changes", () => {
    const view = render(
      <Owner
        registration={{
          projectName: "command-center",
          sessionName: null,
          conversationId: "first",
          title: "First",
        }}
      />,
    );

    view.rerender(
      <Owner
        registration={{
          projectName: "command-center",
          sessionName: null,
          conversationId: "second",
          title: "Second",
        }}
      />,
    );

    expect(useQuickTicketStore.getState().conversationRegistry).toMatchObject([
      { conversationId: "second", title: "Second" },
    ]);
  });
});
