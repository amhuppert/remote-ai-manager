// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import JoinConflictRecoveryCard from "./JoinConflictRecoveryCard";
import type { JoinConflictSummary } from "./join-conflict-summary";

const BLOCKED_SETTINGS = {
  contextId: "ctx_settings",
  title: "Settings surface",
  laneId: "lane-settings",
  status: "blocked",
  detail: "both wrote the timeout branch",
} satisfies JoinConflictSummary["members"][number];

const SUMMARY: JoinConflictSummary = {
  joinId: "join_delivery_1",
  laneLabel: "delivery",
  members: [
    {
      contextId: "ctx_rules",
      title: "Rules",
      laneId: "lane-rules",
      status: "merged",
      detail: null,
    },
    {
      contextId: "ctx_checkout",
      title: "Implement checkout",
      laneId: "lane-checkout",
      status: "merged",
      detail: null,
    },
    BLOCKED_SETTINGS,
  ],
  mergedCount: 2,
  blockedMember: BLOCKED_SETTINGS,
  conflictFiles: ["src/foo.ts"],
};

const ANALYSIS = [
  {
    file: "src/foo.ts",
    description: "Both sides changed the loader signature.",
    resolution: "Keep both parameters and merge the option objects.",
    rationale: "The changes are logically independent.",
  },
];

describe("JoinConflictRecoveryCard", () => {
  it("shows the resolver's per-file analysis when present", () => {
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts", "src/bar.ts"]}
        analysis={ANALYSIS}
        onRetry={() => {}}
        isRetrying={false}
        disabled={false}
      />,
    );

    expect(
      screen.getByText("Both sides changed the loader signature."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Keep both parameters and merge the option objects./),
    ).toBeInTheDocument();
    // Files without analysis still get a row (and a guidance input).
    expect(screen.getByText("src/bar.ts")).toBeInTheDocument();
  });

  it("submits per-file guidance only for files with feedback", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts", "src/bar.ts"]}
        analysis={null}
        onRetry={onRetry}
        isRetrying={false}
        disabled={false}
      />,
    );

    await user.type(
      screen.getByLabelText("Guidance for src/foo.ts"),
      "keep both hunks",
    );
    await user.click(screen.getByRole("button", { name: /retry join/i }));

    expect(onRetry).toHaveBeenCalledWith([
      { file: "src/foo.ts", decision: "rejected", feedback: "keep both hunks" },
    ]);
  });

  it("retries with no guidance when nothing was entered", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        onRetry={onRetry}
        isRetrying={false}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry join/i }));
    expect(onRetry).toHaveBeenCalledWith([]);
  });

  it("names the lane, the join, and which members merged or blocked", () => {
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        summary={SUMMARY}
        onRetry={() => {}}
        isRetrying={false}
        disabled={false}
      />,
    );

    expect(screen.getByText("Join conflict — delivery")).toBeInTheDocument();
    expect(screen.getByText("join_delivery_1")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 members merged/)).toBeInTheDocument();
    const members = screen.getByTestId("join-members");
    expect(members).toHaveTextContent("merged · Rules → delivery");
    expect(members).toHaveTextContent(
      "blocked · Settings surface → delivery — both wrote the timeout branch",
    );
    expect(screen.getAllByText("src/foo.ts").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /Resolve in the lane worktree, or narrow one member's owned paths/,
      ),
    ).toBeInTheDocument();
  });

  it("sends the operator to the blocked member's worktree and ownership", async () => {
    const user = userEvent.setup();
    const onOpenLaneWorktree = vi.fn();
    const onEditOwnership = vi.fn();
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        summary={SUMMARY}
        onRetry={() => {}}
        onOpenLaneWorktree={onOpenLaneWorktree}
        onEditOwnership={onEditOwnership}
        isRetrying={false}
        disabled={false}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open lane worktree" }),
    );
    expect(onOpenLaneWorktree).toHaveBeenCalledWith("ctx_settings");

    await user.click(screen.getByRole("button", { name: "Edit ownership" }));
    expect(onEditOwnership).toHaveBeenCalledWith("ctx_settings");
  });

  it("offers no navigation a host cannot honour", () => {
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        summary={SUMMARY}
        onRetry={() => {}}
        isRetrying={false}
        disabled={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Open lane worktree" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit ownership" })).toBeNull();
  });

  it("disables the retry button while a retry is pending", () => {
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        onRetry={() => {}}
        isRetrying={true}
        disabled={true}
      />,
    );

    expect(screen.getByRole("button", { name: /retrying/i })).toBeDisabled();
  });

  // A blocked retry has to block the ACT, not just the button. The guidance
  // input's primary action (⌘/ctrl↵, and the voice control's submit) reaches the
  // same retry, and a retry is what resumes the run — so a card that only
  // disabled the visible button would let an unrepaired output-schema contract
  // be resumed from the keyboard.
  describe("when something else withholds the retry", () => {
    const blockedProps = {
      conflictFiles: ["src/foo.ts"],
      analysis: null,
      isRetrying: false,
      disabled: false,
      retryBlockedReason: "blocked until the contract is accepted",
    };

    it("names the reason on the retry button and disables it", () => {
      render(<JoinConflictRecoveryCard {...blockedProps} onRetry={() => {}} />);

      expect(
        screen.getByRole("button", {
          name: "Retry join — blocked until the contract is accepted",
        }),
      ).toBeDisabled();
    });

    it("does not retry from the guidance input's keyboard shortcut", async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      render(<JoinConflictRecoveryCard {...blockedProps} onRetry={onRetry} />);

      const guidance = screen.getByLabelText("Guidance for src/foo.ts");
      await user.click(guidance);
      await user.type(guidance, "keep both hunks");
      await user.keyboard("{Control>}{Enter}{/Control}");
      await user.keyboard("{Meta>}{Enter}{/Meta}");

      expect(onRetry).not.toHaveBeenCalled();
    });

    // Drafting guidance is not a resuming act: the operator repairs the
    // contract and keeps the note they already typed.
    it("still accepts typed guidance", async () => {
      const user = userEvent.setup();
      render(<JoinConflictRecoveryCard {...blockedProps} onRetry={() => {}} />);

      const guidance = screen.getByLabelText("Guidance for src/foo.ts");
      await user.type(guidance, "keep both hunks");
      expect(guidance).toHaveValue("keep both hunks");
    });
  });
});
