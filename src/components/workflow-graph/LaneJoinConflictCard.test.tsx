// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import LaneJoinConflictCard from "./LaneJoinConflictCard";
import type {
  JoinConflictMember,
  JoinConflictSummary,
} from "./join-conflict-summary";

afterEach(cleanup);

const BLOCKED: JoinConflictMember = {
  laneId: "lane-settings",
  contextId: "ctx_settings",
  title: "Settings",
  status: "blocked",
  detail: "both wrote the timeout branch",
};

const SUMMARY: JoinConflictSummary = {
  joinId: "join_delivery_1",
  laneLabel: "delivery",
  mergedCount: 1,
  blockedMember: BLOCKED,
  conflictFiles: ["src/checkout/audit.ts"],
  members: [
    {
      laneId: "lane-rules",
      contextId: "ctx_rules",
      title: "Rules",
      status: "merged",
      detail: null,
    },
    BLOCKED,
  ],
};

describe("LaneJoinConflictCard", () => {
  it("names the join, the target lane and which member is blocked", () => {
    render(<LaneJoinConflictCard summary={SUMMARY} />);

    const card = screen.getByTestId("lane-join-conflict-card");
    expect(card).toHaveTextContent("Join conflict — delivery");
    expect(card).toHaveTextContent("join_delivery_1");
    expect(card).toHaveTextContent("1 of 2 members merged");
    expect(card).toHaveTextContent("Settings");
    expect(card).toHaveTextContent("both wrote the timeout branch");
  });

  it("states every member's merge outcome", () => {
    render(<LaneJoinConflictCard summary={SUMMARY} />);

    const members = within(
      screen.getByTestId("lane-join-conflict-card"),
    ).getByTestId("lane-join-members");
    expect(members).toHaveTextContent("merged · Rules → delivery");
    expect(members).toHaveTextContent("blocked · Settings → delivery");
  });

  // A lane has no grade and the card belongs to the join, not to the lane: the
  // accessible name has to say which join it is so a reader arriving by
  // keyboard knows what the controls act on.
  it("anchors on the target lane's band as a named group", () => {
    render(<LaneJoinConflictCard summary={SUMMARY} />);

    const card = screen.getByRole("group", {
      name: /Join conflict on lane delivery/,
    });
    expect(card).toHaveAttribute("data-lane-name", "delivery");
  });

  it("sends the blocked member's two ways out to its runtime and its ownership", () => {
    const onOpenLaneWorktree = vi.fn();
    const onEditOwnership = vi.fn();
    render(
      <LaneJoinConflictCard
        summary={SUMMARY}
        onOpenLaneWorktree={onOpenLaneWorktree}
        onEditOwnership={onEditOwnership}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open lane worktree" }));
    expect(onOpenLaneWorktree).toHaveBeenCalledWith("ctx_settings");

    fireEvent.click(screen.getByRole("button", { name: "Edit ownership" }));
    expect(onEditOwnership).toHaveBeenCalledWith("ctx_settings");
  });

  // Every context in a blocked lane is reported blocked, but only one is the
  // subject. The sentence and the buttons must agree on which — a card that
  // describes one context and opens another sends the operator somewhere it
  // never named.
  it("acts on the member it names when several contexts share the blocked lane", () => {
    const onEditOwnership = vi.fn();
    const alsoBlocked: JoinConflictMember = {
      laneId: "lane-settings",
      contextId: "ctx_rollout",
      title: "Rollout",
      status: "blocked",
      detail: "both wrote the timeout branch",
    };
    render(
      <LaneJoinConflictCard
        summary={{
          ...SUMMARY,
          // Listed FIRST among the blocked, but not the subject.
          members: [SUMMARY.members[0]!, alsoBlocked, BLOCKED],
          blockedMember: BLOCKED,
        }}
        onEditOwnership={onEditOwnership}
      />,
    );

    const card = screen.getByTestId("lane-join-conflict-card");
    expect(
      within(card).getByTestId("lane-join-conflict-subject"),
    ).toHaveTextContent("Settings");

    fireEvent.click(screen.getByRole("button", { name: "Edit ownership" }));
    expect(onEditOwnership).toHaveBeenCalledWith("ctx_settings");
  });

  // No blocked context means no destination, so the card states the conflict
  // without offering controls that would navigate nowhere.
  it("offers no navigation when the roster cannot name the blocked member", () => {
    render(
      <LaneJoinConflictCard
        summary={{
          ...SUMMARY,
          blockedMember: {
            ...BLOCKED,
            contextId: null,
            title: "lane-settings",
          },
          members: SUMMARY.members.map((member) => ({
            ...member,
            contextId: null,
          })),
        }}
        onOpenLaneWorktree={vi.fn()}
        onEditOwnership={vi.fn()}
      />,
    );

    expect(screen.getByTestId("lane-join-conflict-card")).toHaveTextContent(
      "Join conflict — delivery",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
