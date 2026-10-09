// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  checkoutHaltedRun,
  checkoutLoopRun,
  checkoutRun,
  noticeRunAwaitingApproval,
  sessionRuns,
} from "../fixtures";
import type { RunDetail } from "../model";
import { RunPage, type RunPageActions } from "./RunPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const actions: RunPageActions = {
  onPause: vi.fn(),
  onResume: vi.fn(),
  onCancel: vi.fn(),
  onRetryLane: vi.fn(),
  onSelectRun: vi.fn(),
  onApplyRemedy: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onOpenConversation: vi.fn(),
};

it("closes a keyboard-opened context with one Escape and restores the opener", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  const user = userEvent.setup();
  render(
    <RunPage runs={sessionRuns} run={checkoutHaltedRun} actions={actions} />,
  );
  const opener = screen.getByRole("button", { name: "Resolve" });
  opener.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(opener).toHaveFocus();
});

it("reads frozen document bytes rather than the newer run document", async () => {
  const user = userEvent.setup();
  render(
    <RunPage
      runs={sessionRuns}
      run={checkoutRun}
      actions={actions}
      initialContext="plan"
    />,
  );
  await user.click(screen.getByRole("tab", { name: "Documents" }));
  await user.click(screen.getByRole("button", { name: /plan.md/ }));
  expect(
    await screen.findByText(
      /Confirm the API boundary before choosing the migration order/,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/Revision 1 ·/)).toBeInTheDocument();
});

it("attention opens the current action even when an earlier pass of that context is selected", async () => {
  const user = userEvent.setup();
  const run: RunDetail = {
    ...checkoutLoopRun,
    attention: [
      {
        kind: "halt",
        contextKey: "polish",
        contextTitle: "Polish copy",
        halt: "turn_failed",
        detail: "Turn stopped",
        at: checkoutRun.startedAt,
      },
    ],
    contexts: checkoutLoopRun.contexts.map((context) =>
      context.key !== "polish"
        ? context
        : {
            ...context,
            state: {
              kind: "halted",
              halt: {
                kind: "turn_failed",
                detail: "Turn stopped",
                occurrence: "current-halt",
                at: checkoutRun.startedAt,
                remedies: [{ kind: "continue" }],
              },
            },
          },
    ),
  };
  render(
    <RunPage
      runs={sessionRuns}
      run={run}
      actions={actions}
      initialContext="polish"
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Invocation" }));
  await user.click(screen.getByRole("option", { name: /Pass 1/ }));
  expect(screen.getByText(/Earlier pass.*read-only/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Resolve" }));
  expect(screen.queryByText(/Earlier pass.*read-only/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("an agent run's attention action focuses the embedded approval", async () => {
  const user = userEvent.setup();
  render(
    <RunPage
      runs={sessionRuns}
      run={noticeRunAwaitingApproval}
      actions={actions}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Current context action")).toHaveFocus(),
  );
});

it("repeating an agent approval attention action preserves unsent rejection feedback", async () => {
  const user = userEvent.setup();
  render(
    <RunPage
      runs={sessionRuns}
      run={noticeRunAwaitingApproval}
      actions={actions}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.type(
    screen.getByRole("textbox", { name: "Rejection feedback" }),
    "Keep the existing notice title.",
  );
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(
    screen.getByRole("textbox", { name: "Rejection feedback" }),
  ).toHaveValue("Keep the existing notice title.");
  expect(screen.getByLabelText("Current context action")).toHaveFocus();
});

it("keeps the current inspection while a refresh loads or fails", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn();
  const props = {
    runs: sessionRuns,
    run: checkoutRun,
    actions,
    initialContext: "plan",
    onRetry,
  };
  const view = render(<RunPage {...props} />);
  await user.click(screen.getByRole("tab", { name: "Documents" }));
  await user.click(screen.getByRole("button", { name: /plan.md/ }));
  expect(
    await screen.findByText(
      /Confirm the API boundary before choosing the migration order/,
    ),
  ).toBeInTheDocument();
  view.rerender(<RunPage {...props} loading />);
  expect(
    screen.getByText(
      /Confirm the API boundary before choosing the migration order/,
    ),
  ).toBeInTheDocument();
  view.rerender(<RunPage {...props} error="Server reconnecting" />);
  expect(
    screen.getByText(
      /Confirm the API boundary before choosing the migration order/,
    ),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("tab", { name: "Documents", selected: true }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry refresh" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("explains missing frozen bytes instead of opening the latest revision or doing nothing", async () => {
  const user = userEvent.setup();
  render(
    <RunPage
      runs={sessionRuns}
      run={{ ...checkoutRun, documentHistory: [] }}
      actions={actions}
      initialContext="plan"
    />,
  );
  await user.click(screen.getByRole("tab", { name: "Documents" }));
  await user.click(screen.getByRole("button", { name: /plan.md/ }));
  expect(
    await screen.findByRole("dialog", { name: /plan.md.*revision 1/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("not loaded");
  expect(
    screen.queryByRole("heading", { name: "Checkout v2 rollout plan" }),
  ).not.toBeInTheDocument();
});

it("lists activity newest first, whatever order the page sends it in", () => {
  const oldestFirst: RunDetail = {
    ...checkoutRun,
    activity: [...checkoutRun.activity].sort((a, b) => a.seq - b.seq),
  };
  render(<RunPage runs={sessionRuns} run={oldestFirst} actions={actions} />);

  const tab = screen.getByRole("tab", { name: "Activity" });
  const panel = document.getElementById(
    tab.getAttribute("aria-controls") ?? "",
  );
  if (panel === null) throw new Error("no activity panel");
  const times = [...panel.querySelectorAll("time")]
    .map((time) => time.getAttribute("datetime"))
    .filter((at): at is string => at !== null);
  expect(times.length).toBeGreaterThan(1);
  expect(times).toEqual([...times].sort().reverse());
});

it("shows a control as working until the server answers, and its refusal at the control", async () => {
  let refuse: (error: Error) => void = () => {};
  const user = userEvent.setup();
  render(
    <RunPage
      runs={sessionRuns}
      run={checkoutRun}
      actions={{
        ...actions,
        onPause: () =>
          new Promise<void>((_resolve, reject) => {
            refuse = reject;
          }),
      }}
    />,
  );

  const pause = screen.getByRole("button", { name: "Pause" });
  await user.click(pause);
  expect(pause).toHaveAttribute("aria-busy", "true");
  // Another control would wait behind it; it says so rather than doing nothing.
  expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
  refuse(new Error("Run run-1 was cancelled"));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Run run-1 was cancelled",
  );
  expect(pause).not.toHaveAttribute("aria-busy", "true");
});

it("shows a lane retry as working, and its refusal beside it", async () => {
  const blocked: RunDetail = {
    ...checkoutRun,
    attention: [
      {
        kind: "run_halt",
        occurrence: "lane-ui-publication-1",
        halt: "lane_publication",
        detail: "The session worktree has uncommitted changes.",
        clearedBy: "retry_lane",
        lane: "ui",
        at: "2026-10-08T19:55:00.000Z",
      },
    ],
  };
  let refuse: (error: Error) => void = () => {};
  const user = userEvent.setup();
  render(
    <RunPage
      runs={sessionRuns}
      run={blocked}
      actions={{
        ...actions,
        onRetryLane: () =>
          new Promise<void>((_resolve, reject) => {
            refuse = reject;
          }),
      }}
    />,
  );

  const [retry] = screen.getAllByRole("button", { name: "Retry lane" });
  if (retry === undefined) throw new Error("no retry button");
  await user.click(retry);
  expect(retry).toHaveAttribute("aria-busy", "true");
  refuse(new Error('Lane "ui" of run run-1 has nothing to retry'));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "has nothing to retry",
  );
});

it("says a run's cost is at least what is known once a seat's conversation is gone", () => {
  render(
    <RunPage
      runs={sessionRuns}
      run={{ ...checkoutRun, costUsd: 2.5, costComplete: false }}
      actions={actions}
    />,
  );

  expect(screen.getByLabelText("at least $2.50")).toHaveTextContent("$2.50+");
});
