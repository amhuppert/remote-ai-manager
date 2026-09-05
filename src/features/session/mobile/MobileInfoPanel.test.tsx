// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import MobileInfoPanel from "./MobileInfoPanel";

describe("MobileInfoPanel", () => {
  it("copies the full worktree path using a keyboard", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    const session = sessionStateSchema.parse({
      sessionName: "mobile-audit",
      worktreePath:
        "/projects/command-center/.worktrees/a-very-long-session-name",
      branchName: "cc/mobile-audit",
      createdAt: "2026-09-05T00:00:00Z",
      lastActivityAt: "2026-09-05T00:00:00Z",
    });
    render(
      <MobileInfoPanel
        session={session}
        activeConversation={undefined}
        conversationId="conversation"
        statusDotClass="idle"
        displayStatus="Idle"
        contextPercent={null}
        buildContext={() => null}
      />,
    );
    screen.getByRole("button", { name: /Worktree/ }).focus();
    await user.keyboard("{Enter}");
    expect(clipboard).toHaveBeenCalledWith(session.worktreePath);
  });
});
