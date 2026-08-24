// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommentComposerCapability } from "@/components/document-viewer/annotation-contract";

import CommentPopover from "./CommentPopover";

const ANCHOR = {
  sectionId: "overview",
  headingLabel: "Overview",
  line: 5,
  charStart: 0,
  charEnd: 23,
  quote: "agent-produced markdown",
  prefix: "",
  suffix: "",
  docRevision: "revision-1",
};

function setup(composer: CommentComposerCapability) {
  const onCancel = vi.fn();
  const onSuccess = vi.fn();
  const onPendingChange = vi.fn();
  const view = render(
    <CommentPopover
      anchor={ANCHOR}
      composer={composer}
      onCancel={onCancel}
      onSuccess={onSuccess}
      onPendingChange={onPendingChange}
    />,
  );
  return { ...view, onCancel, onSuccess, onPendingChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CommentPopover", () => {
  it("shows the selected passage preview", () => {
    setup({ kind: "persist-only", submit: vi.fn() });
    expect(screen.getByText(/agent-produced markdown/)).toBeInTheDocument();
  });

  it("uses touch-size, contrast-safe comment actions", () => {
    setup({ kind: "persist-or-send", submit: vi.fn() });

    for (const name of ["Cancel", "Add comment", "Add & send"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "min-h-[44px]",
        "min-w-[44px]",
      );
    }
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
      "text-text-primary",
    );
  });

  it("fits a narrow zoomed viewport and wraps its action row", () => {
    const { container } = setup({ kind: "persist-or-send", submit: vi.fn() });

    expect(container.firstElementChild).toHaveClass("max-w-[calc(100vw-16px)]");
    expect(
      screen.getByRole("button", { name: "Cancel" }).parentElement,
    ).toHaveClass("flex-wrap");
  });

  it("keeps wrapped editor controls reachable within the available popover height", () => {
    const { container } = setup({ kind: "persist-or-send", submit: vi.fn() });

    expect(container.firstElementChild).toHaveClass(
      "max-h-[var(--radix-popover-content-available-height)]",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(screen.getByText(/agent-produced markdown/)).toHaveClass(
      "overflow-y-auto",
    );
  });

  it("fits the visual viewport at browser zoom and tracks zoom changes", () => {
    const visualViewport = Object.assign(new EventTarget(), {
      width: 195,
      height: 422,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 2,
    });
    vi.stubGlobal("visualViewport", visualViewport);

    const { container } = setup({
      kind: "persist-or-send",
      submit: vi.fn(),
    });
    expect(container.firstElementChild).toHaveStyle({ maxWidth: "179px" });

    visualViewport.width = 160;
    act(() => visualViewport.dispatchEvent(new Event("resize")));
    expect(container.firstElementChild).toHaveStyle({ maxWidth: "144px" });
  });

  it("renders only Add comment for persist-only composition", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(undefined);
    setup({ kind: "persist-only", submit });

    await user.type(screen.getByRole("textbox"), "  please clarify  ");
    expect(
      screen.queryByRole("button", { name: /add & send/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    expect(submit).toHaveBeenCalledWith({
      anchor: ANCHOR,
      note: "please clarify",
    });
  });

  it("keeps queue and send distinct for persist-or-send composition", async () => {
    const user = userEvent.setup();
    const queueSubmit = vi.fn().mockResolvedValue(undefined);
    const queue = setup({ kind: "persist-or-send", submit: queueSubmit });
    await user.type(screen.getByRole("textbox"), "queue this");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(queueSubmit).toHaveBeenCalledWith({
      anchor: ANCHOR,
      note: "queue this",
      delivery: "queue",
    });
    expect(queue.onSuccess).toHaveBeenCalledOnce();

    document.body.innerHTML = "";
    const sendSubmit = vi.fn().mockResolvedValue(undefined);
    setup({ kind: "persist-or-send", submit: sendSubmit });
    await user.type(screen.getByRole("textbox"), "send this");
    await user.click(screen.getByRole("button", { name: "Add & send" }));
    expect(sendSubmit).toHaveBeenCalledWith({
      anchor: ANCHOR,
      note: "send this",
      delivery: "send",
    });
  });

  it("disables every action and ignores Escape while submission is pending", async () => {
    const user = userEvent.setup();
    let settle: (() => void) | undefined;
    const submit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { onCancel, onPendingChange } = setup({
      kind: "persist-only",
      submit,
    });
    await user.type(screen.getByRole("textbox"), "keep this draft");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);

    settle?.();
  });

  it("retains the exact note and announces a rejected submission", async () => {
    const user = userEvent.setup();
    const submit = vi
      .fn()
      .mockRejectedValue(new Error("Revision is no longer proposed"));
    const { onSuccess } = setup({ kind: "persist-only", submit });
    const note = screen.getByRole("textbox");
    await user.type(note, "  preserve my spacing  ");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision is no longer proposed",
    );
    expect(note).toHaveValue("  preserve my spacing  ");
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(note).toHaveAccessibleDescription("Revision is no longer proposed");
    expect(screen.getByRole("alert")).toHaveClass(
      "bg-bg-base",
      "text-red-text",
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("uses the selected capability for the keyboard primary action", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(undefined);
    setup({ kind: "persist-or-send", submit });
    await user.type(screen.getByRole("textbox"), "keyboard submit");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(submit).toHaveBeenCalledWith({
      anchor: ANCHOR,
      note: "keyboard submit",
      delivery: "send",
    });
  });
});
