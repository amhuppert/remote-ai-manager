// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { publicConversationStateSchema } from "@/lib/conversations/schemas";
import SessionConversationRow from "./SessionConversationRow";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

afterEach(cleanup);

it("returns keyboard focus to the conversation actions after saving a rename", async () => {
  let completeRename = () => {};
  const save = new Promise<void>((resolve) => {
    completeRename = resolve;
  });
  function Harness() {
    const [conversation, setConversation] = useState(() =>
      publicConversationStateSchema.parse({
        id: "review",
        name: "Release review",
        transcriptPath: null,
        status: "awaiting",
        promptCount: 2,
        createdAt: "2026-09-11T09:00:00Z",
        lastActivityAt: "2026-09-11T10:00:00Z",
      }),
    );
    return (
      <ul>
        <SessionConversationRow
          conversation={conversation}
          onArchive={() => {}}
          onRename={async (_id, name) => {
            await save;
            setConversation((current) => ({ ...current, name }));
          }}
        />
      </ul>
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  screen.getByRole("button", { name: "Actions for Release review" }).focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Rename conversation" }),
  );
  const input = await screen.findByRole("textbox", {
    name: "Conversation name",
  });
  await user.clear(input);
  await user.type(input, "Readiness review");
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Saving…" });
  await act(async () => completeRename());
  await screen.findByRole("heading", { name: "Readiness review" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Readiness review" }),
    ).toHaveFocus(),
  );
});
