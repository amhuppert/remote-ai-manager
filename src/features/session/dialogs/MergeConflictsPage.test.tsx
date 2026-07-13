// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MergeConflictsPage, { type ConflictEntry } from "./MergeConflictsPage";

const conflicts: ConflictEntry[] = [
  {
    file: "src/a.ts",
    description: "Both branches touched the same function.",
    resolution: "Keep the session branch version.",
    rationale: "The session branch carries the newer contract.",
  },
];

const baseProps = {
  projectName: "proj",
  sessionName: "sess",
  branchName: "csm/sess",
  conflicts,
};

afterEach(() => {
  cleanup();
});

describe("MergeConflictsPage submit pending feedback", () => {
  it("shows Submitting… on the accept-all button after it was clicked and the submission is pending", async () => {
    const onAcceptAll = vi.fn();
    const { rerender } = render(
      <MergeConflictsPage
        {...baseProps}
        onAcceptAll={onAcceptAll}
        isSubmitting={false}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /accept all and fix/i }),
    );
    expect(onAcceptAll).toHaveBeenCalledTimes(1);

    rerender(
      <MergeConflictsPage
        {...baseProps}
        onAcceptAll={onAcceptAll}
        isSubmitting
      />,
    );
    const pending = screen.getByRole("button", { name: /submitting…/i });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    // The other submit control disables without claiming to be in flight.
    expect(
      screen.getByRole("button", { name: /fix with claude/i }),
    ).toBeDisabled();
  });

  it("shows Submitting… on the fix-approved button after it was clicked and the submission is pending", async () => {
    const onFixApproved = vi.fn();
    const { rerender } = render(
      <MergeConflictsPage
        {...baseProps}
        onFixApproved={onFixApproved}
        isSubmitting={false}
      />,
    );
    // Approve the conflict so "Fix with Claude" is enabled.
    await userEvent.click(
      screen.getByRole("button", { name: /approve this resolution/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /fix with claude/i }),
    );
    expect(onFixApproved).toHaveBeenCalledTimes(1);

    rerender(
      <MergeConflictsPage
        {...baseProps}
        onFixApproved={onFixApproved}
        isSubmitting
      />,
    );
    const pending = screen.getByRole("button", { name: /submitting…/i });
    expect(pending).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /accept all and fix/i }),
    ).toBeDisabled();
  });

  it("keeps both submit controls enabled when nothing is in flight", async () => {
    render(<MergeConflictsPage {...baseProps} isSubmitting={false} />);
    await userEvent.click(
      screen.getByRole("button", { name: /approve this resolution/i }),
    );
    expect(
      screen.getByRole("button", { name: /accept all and fix/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /fix with claude/i }),
    ).toBeEnabled();
  });

  it("submits rejected-conflict guidance through the multiline primary chord", async () => {
    const onFixApproved = vi.fn();
    render(<MergeConflictsPage {...baseProps} onFixApproved={onFixApproved} />);
    await userEvent.click(
      screen.getByRole("button", { name: /reject this resolution/i }),
    );
    const guidance = screen.getByRole("textbox", {
      name: "Guidance for Claude",
    });
    await userEvent.type(guidance, "Keep both branches");
    await userEvent.type(guidance, "{Control>}{Enter}{/Control}");

    expect(onFixApproved).toHaveBeenCalledWith([
      expect.objectContaining({
        file: "src/a.ts",
        decision: "rejected",
        feedback: "Keep both branches",
      }),
    ]);
  });
});
