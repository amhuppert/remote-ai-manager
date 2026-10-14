// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AttentionItem, RunSummary } from "./model";
import { OwnerRunCard, SessionRunsCard } from "./RunCards";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const run: RunSummary = {
  runId: "run-1",
  title: "Checkout v2 rollout",
  kind: "workflow",
  status: { kind: "needs_input" },
  attention: 2,
  contexts: { done: 2, total: 6 },
  costUsd: 12.4,
  costComplete: true,
  startedAt: "2026-10-08T14:14:00.000Z",
  finishedAt: null,
  owner: { conversationId: "owner-1", title: "Owner", backend: "claude" },
};

const unconsumed: AttentionItem = { kind: "stalled", causes: ["effect-1"] };
const laneStop: AttentionItem = {
  kind: "run_halt",
  occurrence: "lane:docs:1",
  halt: "lane_publication",
  detail: "The docs lane could not publish.",
  clearedBy: "retry_lane",
  lane: "docs",
  at: "2026-10-08T14:20:00.000Z",
};
const approval: AttentionItem = {
  kind: "approval",
  contextKey: "ui",
  contextTitle: "Build the UI",
  requestedAt: "2026-10-08T14:22:00.000Z",
  reviewersPassed: 1,
};

const hrefOf = (contextKey?: string) =>
  contextKey === undefined
    ? "/runs?run=run-1"
    : `/runs?run=run-1&context=${contextKey}`;

describe("a run in its owner's conversation", () => {
  it("names finished work nothing picked up, for the run as a whole", () => {
    render(
      <OwnerRunCard
        run={run}
        attention={[unconsumed]}
        hrefOf={hrefOf}
        onControl={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Finished work was not picked up"),
    ).toBeInTheDocument();
  });

  it("leads to the run, and to the context whose result waits for the person", () => {
    render(
      <OwnerRunCard
        run={run}
        attention={[approval]}
        hrefOf={hrefOf}
        onControl={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      "/runs?run=run-1",
    );
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/runs?run=run-1&context=ui",
    );
  });

  it("acts in place: the action works until the run answers, the others wait, and a refusal stays beside it", async () => {
    const user = userEvent.setup();
    let refuse: (error: Error) => void = () => {};
    const onControl = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    render(
      <OwnerRunCard
        run={run}
        attention={[unconsumed, laneStop]}
        hrefOf={hrefOf}
        onControl={onControl}
      />,
    );

    const resume = screen.getByRole("button", { name: "Resume" });
    await user.click(resume);

    expect(onControl).toHaveBeenCalledWith({ action: "resume" });
    expect(resume).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Retry docs lane" }),
    ).toBeDisabled();

    refuse(new Error("The run is stopping and cannot be resumed"));

    const line = resume.closest("li");
    if (line === null) throw new Error("Resume is not in a line");
    expect(await within(line).findByRole("alert")).toHaveTextContent(
      "The run is stopping and cannot be resumed",
    );
    expect(resume).not.toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Retry docs lane" }),
    ).toBeEnabled();
  });

  it("lets a refusal go with the line it answered", async () => {
    const user = userEvent.setup();
    const props = {
      run,
      hrefOf,
      onControl: vi.fn(async () => {
        throw new Error("The lane is already being retried");
      }),
    };
    const { rerender } = render(
      <OwnerRunCard {...props} attention={[unconsumed, laneStop]} />,
    );

    await user.click(screen.getByRole("button", { name: "Retry docs lane" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    rerender(<OwnerRunCard {...props} attention={[unconsumed]} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a run's lanes stopped alike, in its owner's conversation", () => {
  it("names each lane, so a retry goes to the lane the person means", async () => {
    const user = userEvent.setup();
    const onControl = vi.fn();
    const uiStop: AttentionItem = {
      ...laneStop,
      occurrence: "lane:ui:1",
      lane: "ui",
    };
    render(
      <OwnerRunCard
        run={run}
        attention={[laneStop, uiStop]}
        hrefOf={hrefOf}
        onControl={onControl}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Retry ui lane" }));

    expect(onControl).toHaveBeenCalledWith({ action: "retry", lane: "ui" });
    expect(
      screen.getByRole("button", { name: "Retry docs lane" }),
    ).toBeInTheDocument();
  });
});

describe("the session's runs on its overview", () => {
  it("offers no template launch while the session's templates start the older workflows", () => {
    render(<SessionRunsCard runs={[]} hrefOf={() => "/runs"} />);

    expect(
      screen.queryByRole("button", { name: "Browse templates" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Ask a conversation to start a run/),
    ).toBeInTheDocument();
  });
});
