// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  checkoutHaltedRun,
  checkoutLoopRun,
  checkoutRun,
  noticeRunAwaitingApproval,
  owner,
  uiCandidate,
} from "../fixtures";
import type { ContextDetail } from "@/components/runs/model";
import { ContextInspector, type ContextActions } from "./ContextInspector";

function context(key: string): ContextDetail {
  const source =
    key === "polish"
      ? checkoutLoopRun
      : key === "migrate"
        ? checkoutHaltedRun
        : checkoutRun;
  const found = source.contexts.find((item) => item.key === key);
  if (found === undefined) throw new Error(`Missing fixture: ${key}`);
  return found;
}

function setup(
  selected: ContextDetail,
  overrides: Partial<ContextActions> = {},
) {
  const actions: ContextActions = {
    onApplyRemedy: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onOpenConversation: vi.fn(),
    onOpenDocument: vi.fn(),
    onOpenCharter: vi.fn(),
    ...overrides,
  };
  const view = render(
    <ContextInspector context={selected} owner={owner} actions={actions} />,
  );
  return { user: userEvent.setup(), actions, view };
}

describe("ContextInspector evidence", () => {
  it("opens the revision the context froze even when the run has a newer document", async () => {
    const { user, actions } = setup(context("plan"));
    await user.click(screen.getByRole("tab", { name: "Documents" }));
    await user.click(screen.getByRole("button", { name: /plan.md/ }));
    expect(actions.onOpenDocument).toHaveBeenCalledWith("plan.md", 1);
    await user.click(screen.getByRole("button", { name: /charter.md/ }));
    expect(actions.onOpenCharter).toHaveBeenCalledWith(1, "plan");
  });

  it("retains the earlier pass's report, output and transcripts in a read-only view", async () => {
    const { user, actions } = setup(context("polish"));
    await user.click(screen.getByRole("combobox", { name: "Invocation" }));
    await user.click(screen.getByRole("option", { name: /Pass 1/ }));
    expect(screen.getByText(/Updated 22 strings/)).toBeInTheDocument();
    expect(screen.getByText(/Earlier pass.*read-only/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Result" }));
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Agents/ }));
    await user.click(
      screen.getByRole("button", { name: "Open the implementer transcript" }),
    );
    expect(actions.onOpenConversation).toHaveBeenCalledWith(
      "c-polish-pass1-implementer",
    );
    expect(actions.onApprove).not.toHaveBeenCalled();
    expect(actions.onApplyRemedy).not.toHaveBeenCalled();
  });

  it("shows dependency and lane publication blockers together", () => {
    setup(context("integrate"));
    expect(
      screen.getByText("Waiting for ui, migrate, polish to succeed."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Lane ui must publish/)).toBeInTheDocument();
  });

  it("shows resolved scope, check policy and retry allowances", async () => {
    const migration = context("migrate");
    const { user } = setup({
      ...migration,
      configuration: {
        ...migration.configuration,
        deferredChecks: ["test-all"],
      },
    });
    await user.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(screen.getByText("db")).toBeInTheDocument();
    expect(screen.getByText("Deferred checks")).toBeInTheDocument();
    expect(screen.getByText("test-all")).toBeInTheDocument();
    expect(screen.getByText("Unfinished task retries")).toBeInTheDocument();
    expect(screen.getByText("0 used · 2 allowed")).toBeInTheDocument();
  });

  it("binds approval to the rendered candidate and shows pending then refusal", async () => {
    const candidate = noticeRunAwaitingApproval.contexts[0];
    if (candidate === undefined || candidate.approval === null)
      throw new Error("Missing approval fixture");
    let refuse: (error: Error) => void = () => {
      throw new Error("Missing pending decision");
    };
    const onApprove = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const { user } = setup(
      {
        ...candidate,
        approval: { ...candidate.approval, candidateId: "candidate-visible" },
      },
      { onApprove },
    );
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledWith(candidate.key, "candidate-visible");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    await act(async () =>
      refuse(new Error("This candidate was superseded. Refresh the run.")),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This candidate was superseded.",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
    );
  });

  it("shows independent owner questions while a review is still running", () => {
    setup({
      ...context("polish"),
      questions: [
        {
          questionId: "q-copy",
          seat: "reviewer-1",
          question: "Keep the existing heading?",
          askedAt: checkoutRun.startedAt,
        },
        {
          questionId: "q-schema",
          seat: "reviewer-2",
          question: "Keep the old enum value?",
          askedAt: checkoutRun.startedAt,
        },
      ],
    });
    expect(screen.getByText("Keep the existing heading?")).toBeInTheDocument();
    expect(screen.getByText("Keep the old enum value?")).toBeInTheDocument();
  });

  it("shows the candidate's changes beside its result when the page has them", async () => {
    const { user } = setup({ ...context("plan"), candidate: uiCandidate });
    await user.click(screen.getByRole("tab", { name: "Result" }));
    expect(
      screen.getByText("src/checkout/ui/PaymentStep.tsx"),
    ).toBeInTheDocument();
  });

  it("keeps the selected historical invocation when earlier passes are reordered", async () => {
    const selected = context("polish");
    const earlier = selected.previousInvocations[0];
    if (earlier === undefined) throw new Error("Missing earlier pass fixture");
    const first = { ...earlier, invocationId: "polish-pass-1" };
    const next = {
      ...earlier,
      invocationId: "polish-pass-2",
      loop: { key: "polish", pass: 2, maxPasses: 3 },
      lastSummary: "Second pass report",
    };
    const initial = {
      ...selected,
      invocationId: "polish-pass-3",
      loop: { key: "polish", pass: 3, maxPasses: 3 },
      previousInvocations: [first, next],
    };
    const { user, actions, view } = setup(initial);
    await user.click(screen.getByRole("combobox", { name: "Invocation" }));
    await user.click(screen.getByRole("option", { name: /Pass 1/ }));
    view.rerender(
      <ContextInspector
        context={{ ...initial, previousInvocations: [next, first] }}
        owner={owner}
        actions={actions}
      />,
    );
    expect(screen.getByText(/Updated 22 strings/)).toBeInTheDocument();
    expect(screen.queryByText("Second pass report")).not.toBeInTheDocument();
  });
});
