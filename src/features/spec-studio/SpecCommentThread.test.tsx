// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SpecThreadAnchorState } from "@/components/document-viewer/annotation-contract";
import { assembleSpecCommentThreads } from "@/lib/specs/comment-threads";
import type { SpecCommentView } from "@/lib/specs/view-schemas";

import SpecCommentThread from "./SpecCommentThread";

function row(
  id: string,
  overrides: Partial<SpecCommentView> = {},
): SpecCommentView {
  return {
    id,
    threadId: "thread-1",
    parentCommentId: id === "root" ? null : "root",
    elementId: "requirement-1",
    handle: "R3",
    revisionId: "revision-4",
    revisionNumber: 4,
    anchor: {
      sectionId: "requirements",
      headingLabel: "Requirements",
      line: 8,
      charStart: 0,
      charEnd: 26,
      quote: "the exact selected passage",
      prefix: "",
      suffix: "",
      docRevision: "revision-4",
    },
    quote: "the exact selected passage",
    body: `Message ${id}`,
    author: { kind: "human" },
    blocking: false,
    resolution: "open",
    createdAt: `2026-08-22T10:1${id === "root" ? "0" : "1"}:00.000Z`,
    updatedAt: "2026-08-22T10:20:00.000Z",
    ...overrides,
  };
}

function thread(rows: SpecCommentView[] = [row("root")]) {
  return assembleSpecCommentThreads(rows)[0]!;
}

const ANCHORED: SpecThreadAnchorState = {
  status: "anchored",
  charStart: 0,
  charEnd: 26,
};

describe("SpecCommentThread", () => {
  it("renders one labelled article, one quote, and an ordered Root/Reply message hierarchy", () => {
    const model = thread([
      row("root"),
      row("claude", {
        author: {
          kind: "agent",
          conversationId: "conversation/a&b",
          backend: "claude",
        },
      }),
      row("generic", {
        author: {
          kind: "agent",
          conversationId: "conversation-generic",
          backend: "mystery",
        },
      }),
      row("legacy", { author: null }),
    ]);
    render(<SpecCommentThread thread={model} anchorState={ANCHORED} />);

    const article = screen.getByRole("article", { name: /review thread/i });
    expect(article).toHaveTextContent("Revision 4");
    expect(article).toHaveTextContent("R3");
    expect(
      within(article).getAllByText(/the exact selected passage/),
    ).toHaveLength(1);
    expect(within(article).getByRole("list").tagName).toBe("OL");
    expect(within(article).getAllByRole("listitem")).toHaveLength(4);
    expect(article).toHaveTextContent("Root");
    expect(article).toHaveTextContent("Reply");
    expect(article).toHaveTextContent("Operator");
    expect(article).toHaveTextContent("Claude agent");
    expect(article).toHaveTextContent("Agent");
    expect(article).toHaveTextContent("Unknown author");
    expect(article.querySelectorAll("time")[0]).toHaveAttribute(
      "datetime",
      model.messages[0]!.createdAt,
    );
    expect(
      within(article).getByRole("link", {
        name: "Open conversation from Claude agent (conversation/a&b)",
      }),
    ).toHaveAttribute("href", "/conversations?c=conversation%2Fa%26b");
  });

  it("gives same-backend agent links conversation-specific accessible names", () => {
    render(
      <SpecCommentThread
        thread={thread([
          row("root"),
          row("first", {
            author: {
              kind: "agent",
              conversationId: "conversation-first",
              backend: "claude",
            },
          }),
          row("second", {
            author: {
              kind: "agent",
              conversationId: "conversation-second",
              backend: "claude",
            },
          }),
        ])}
        anchorState={ANCHORED}
      />,
    );

    const names = screen
      .getAllByRole("link", { name: /Open conversation from Claude agent/ })
      .map((link) => link.getAttribute("aria-label"));
    expect(names).toEqual([
      "Open conversation from Claude agent (conversation-first)",
      "Open conversation from Claude agent (conversation-second)",
    ]);
  });

  it("reserves enough scroll clearance for the stacked mobile review footer", () => {
    render(<SpecCommentThread thread={thread()} anchorState={ANCHORED} />);

    expect(screen.getByRole("article", { name: /review thread/i })).toHaveClass(
      "max-768:scroll-mb-[260px]",
    );
  });

  it("shows only informative lifecycle, anchor, placement, and integrity chips", () => {
    const { rerender } = render(
      <SpecCommentThread thread={thread()} anchorState={ANCHORED} />,
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Anchored")).not.toBeInTheDocument();

    rerender(
      <SpecCommentThread
        thread={thread([row("root", { blocking: true })])}
        anchorState={{ status: "reanchored", charStart: 2, charEnd: 28 }}
      />,
    );
    expect(screen.getByText("Blocking")).toBeInTheDocument();
    expect(screen.getByText("Reanchored")).toBeInTheDocument();

    for (const [resolution, label] of [
      ["resolved", "Resolved"],
      ["dismissed", "Dismissed"],
    ] as const) {
      rerender(
        <SpecCommentThread
          thread={thread([row("root", { resolution })])}
          anchorState={{ status: "stale" }}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("Stale anchor")).toBeInTheDocument();
    }

    rerender(
      <SpecCommentThread
        thread={thread()}
        anchorState={{ status: "orphaned" }}
        fallbackReason="unsupported-host"
      />,
    );
    expect(screen.getByText("Orphaned")).toBeInTheDocument();
    expect(screen.getByText("Unplaced")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This thread cannot be placed beside its subject in this view.",
      ),
    ).toBeInTheDocument();

    rerender(
      <SpecCommentThread
        thread={thread([
          row("root"),
          row("second-root", { parentCommentId: null }),
        ])}
        anchorState={ANCHORED}
      />,
    );
    expect(screen.getByText("Thread data incomplete")).toBeInTheDocument();
  });

  it.each([
    ["historical-revision", "This thread belongs to an earlier revision."],
    [
      "removed-element",
      "The reviewed element is not present in this revision.",
    ],
    ["invalid-anchor", "The saved comment anchor is incomplete or invalid."],
  ] as const)("explains %s fallback placement", (fallbackReason, copy) => {
    render(
      <SpecCommentThread
        thread={thread()}
        anchorState={
          fallbackReason === "removed-element"
            ? { status: "orphaned" }
            : fallbackReason === "invalid-anchor"
              ? { status: "stale" }
              : ANCHORED
        }
        fallbackReason={fallbackReason}
      />,
    );

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("explains invalid thread data and exposes no actions", () => {
    render(
      <SpecCommentThread
        thread={thread([
          row("root"),
          row("second-root", { parentCommentId: null }),
        ])}
        anchorState={ANCHORED}
        fallbackReason="invalid-thread"
        onReply={vi.fn()}
        onResolve={vi.fn()}
      />,
    );

    expect(screen.getByText("Thread data incomplete")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Thread data is incomplete, so reply and resolve are unavailable.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("hides actions without callback capabilities", () => {
    render(<SpecCommentThread thread={thread()} anchorState={ANCHORED} />);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("focuses Reply, disables pending actions, retains failures, and restores focus on cancel or success", async () => {
    const user = userEvent.setup();
    const onReply = vi
      .fn<(body: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Reply refused"))
      .mockResolvedValueOnce(undefined);
    render(
      <SpecCommentThread
        thread={thread()}
        anchorState={ANCHORED}
        onReply={onReply}
      />,
    );
    const reply = screen.getByRole("button", { name: "Reply" });
    await user.click(reply);
    const input = screen.getByRole("textbox", {
      name: "Reply to review thread",
    });
    expect(input).toHaveFocus();
    await user.type(input, "retain failed reply");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Reply refused");
    expect(input).toHaveValue("retain failed reply");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Reply refused");

    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Reply added");
    expect(reply).toHaveFocus();

    await user.click(reply);
    await user.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(reply).toHaveFocus();
  });

  it("shows pending reply state and focuses the article after resolve", async () => {
    const user = userEvent.setup();
    let settleReply: (() => void) | undefined;
    const onReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleReply = resolve;
        }),
    );
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(
      <SpecCommentThread
        thread={thread()}
        anchorState={ANCHORED}
        onReply={onReply}
        onResolve={onResolve}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reply to review thread" }),
      "pending reply",
    );
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(screen.getByRole("button", { name: "Replying…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel reply" })).toBeDisabled();
    settleReply?.();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thread resolved",
    );
    expect(
      screen.getByRole("article", { name: /review thread/i }),
    ).toHaveFocus();
  });

  it("keeps resolve failures separate from an open reply draft", async () => {
    const user = userEvent.setup();
    render(
      <SpecCommentThread
        thread={thread()}
        anchorState={ANCHORED}
        onReply={vi.fn().mockResolvedValue(undefined)}
        onResolve={vi.fn().mockRejectedValue(new Error("Resolve refused"))}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));
    const input = screen.getByRole("textbox", {
      name: "Reply to review thread",
    });
    await user.type(input, "unrelated reply draft");
    await user.click(screen.getByRole("button", { name: "Resolve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Resolve refused",
    );
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).toHaveValue("unrelated reply draft");
  });

  it("prevents reply and resolve mutations from overlapping", async () => {
    const user = userEvent.setup();
    let settleReply: (() => void) | undefined;
    let settleResolve: (() => void) | undefined;
    const onReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleReply = resolve;
        }),
    );
    const onResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleResolve = resolve;
        }),
    );
    render(
      <SpecCommentThread
        thread={thread()}
        anchorState={ANCHORED}
        onReply={onReply}
        onResolve={onResolve}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reply to review thread" }),
      "pending reply",
    );
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    const resolve = screen.getByRole("button", { name: "Resolve" });
    expect(resolve).toBeDisabled();
    await user.click(resolve);
    expect(onResolve).not.toHaveBeenCalled();
    await act(async () => settleReply?.());
    await waitFor(() => expect(resolve).toBeEnabled());

    await user.click(resolve);
    expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledOnce();
    await act(async () => settleResolve?.());
  });
});
