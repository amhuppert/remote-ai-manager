// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkoutHaltedRun, checkoutLoopRun, checkoutRun, noticeRunAwaitingApproval, sessionRuns } from "../fixtures";
import type { RunDetail } from "../model";
import { RunPage, type RunPageActions } from "./RunPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const actions: RunPageActions = {
  onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn(), onRetryLane: vi.fn(),
  onSelectRun: vi.fn(), onApplyRemedy: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(),
  onOpenConversation: vi.fn(),
};

it("closes a keyboard-opened context with one Escape and restores the opener", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    matches: true, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }));
  const user = userEvent.setup();
  render(<RunPage runs={sessionRuns} run={checkoutHaltedRun} actions={actions} />);
  const opener = screen.getByRole("button", { name: "Resolve" });
  opener.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
});

it("reads frozen document bytes rather than the newer run document", async () => {
  const user = userEvent.setup();
  render(<RunPage runs={sessionRuns} run={checkoutRun} actions={actions} initialContext="plan" />);
  await user.click(screen.getByRole("tab", { name: "Documents" }));
  await user.click(screen.getByRole("button", { name: /plan.md/ }));
  expect(await screen.findByText(/Confirm the API boundary before choosing the migration order/)).toBeInTheDocument();
  expect(screen.getByText(/Revision 1 ·/)).toBeInTheDocument();
});

it("attention opens the current action even when an earlier pass of that context is selected", async () => {
  const user = userEvent.setup();
  const run: RunDetail = {
    ...checkoutLoopRun,
    attention: [{ kind: "halt", contextKey: "polish", contextTitle: "Polish copy", halt: "turn_failed", detail: "Turn stopped", at: checkoutRun.startedAt }],
    contexts: checkoutLoopRun.contexts.map(context => context.key !== "polish" ? context : {
      ...context, state: { kind: "halted", halt: { kind: "turn_failed", detail: "Turn stopped", occurrence: "current-halt", at: checkoutRun.startedAt, remedies: [{ kind: "continue" }] } },
    }),
  };
  render(<RunPage runs={sessionRuns} run={run} actions={actions} initialContext="polish" />);
  await user.click(screen.getByRole("combobox", { name: "Invocation" }));
  await user.click(screen.getByRole("option", { name: /Pass 1/ }));
  expect(screen.getByText(/Earlier pass.*read-only/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Resolve" }));
  expect(screen.queryByText(/Earlier pass.*read-only/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("an agent run's attention action focuses the embedded approval", async () => {
  const user = userEvent.setup();
  render(<RunPage runs={sessionRuns} run={noticeRunAwaitingApproval} actions={actions} />);
  await user.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(screen.getByLabelText("Current context action")).toHaveFocus());
});

it("repeating an agent approval attention action preserves unsent rejection feedback", async () => {
  const user = userEvent.setup();
  render(<RunPage runs={sessionRuns} run={noticeRunAwaitingApproval} actions={actions} />);
  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.type(screen.getByRole("textbox", { name: "Rejection feedback" }), "Keep the existing notice title.");
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(screen.getByRole("textbox", { name: "Rejection feedback" })).toHaveValue("Keep the existing notice title.");
  expect(screen.getByLabelText("Current context action")).toHaveFocus();
});

it("keeps the current inspection while a refresh loads or fails", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn();
  const props = { runs: sessionRuns, run: checkoutRun, actions, initialContext: "plan", onRetry };
  const view = render(<RunPage {...props} />);
  await user.click(screen.getByRole("tab", { name: "Documents" }));
  await user.click(screen.getByRole("button", { name: /plan.md/ }));
  expect(await screen.findByText(/Confirm the API boundary before choosing the migration order/)).toBeInTheDocument();
  view.rerender(<RunPage {...props} loading />);
  expect(screen.getByText(/Confirm the API boundary before choosing the migration order/)).toBeInTheDocument();
  view.rerender(<RunPage {...props} error="Server reconnecting" />);
  expect(screen.getByText(/Confirm the API boundary before choosing the migration order/)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("tab", { name: "Documents", selected: true })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry refresh" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("explains missing frozen bytes instead of opening the latest revision or doing nothing", async () => {
  const user = userEvent.setup();
  render(<RunPage runs={sessionRuns} run={{ ...checkoutRun, documentHistory: [] }} actions={actions} initialContext="plan" />);
  await user.click(screen.getByRole("tab", { name: "Documents" }));
  await user.click(screen.getByRole("button", { name: /plan.md/ }));
  expect(await screen.findByRole("dialog", { name: /plan.md.*revision 1/ })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("not loaded");
  expect(screen.queryByRole("heading", { name: "Checkout v2 rollout plan" })).not.toBeInTheDocument();
});
