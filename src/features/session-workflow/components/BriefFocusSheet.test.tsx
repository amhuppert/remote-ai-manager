// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import BriefFocusSheet from "./BriefFocusSheet";

afterEach(cleanup);

function renderSheet(overrides: Partial<{ content: string }> = {}) {
  const onOpenChange = vi.fn();
  render(
    <BriefFocusSheet
      open
      onOpenChange={onOpenChange}
      fieldLabel="Acceptance criteria"
      contextTitle="Canonicalize Markdown rendering"
      content={overrides.content ?? "## Rollout\n\nShip the migration."}
    />,
  );
  return { onOpenChange };
}

describe("BriefFocusSheet", () => {
  it("renders the brief content through the canonical document adapter", async () => {
    renderSheet();

    const heading = await screen.findByRole("heading", { name: "Rollout" });
    expect(heading.tagName).toBe("H2");
    expect(heading.closest("[data-markdown-intent='document']")).not.toBeNull();
    // Raw markdown markers must not leak into the rendered output.
    expect(screen.queryByText(/## Rollout/)).not.toBeInTheDocument();
  });

  it("keeps the host-owned scroll container without a generated-element typography hook", async () => {
    renderSheet();

    const heading = await screen.findByRole("heading", { name: "Rollout" });
    const scrollContainer = heading.closest(
      "[data-markdown-intent='document']",
    )!.parentElement!;
    // The host owns the height constraint and scrolling for the long-form brief.
    expect(scrollContainer.className).toContain("max-h-[60vh]");
    expect(scrollContainer.className).toContain("overflow-y-auto");
    // The host carries no generated-element typography hook; DocumentMarkdown
    // owns typography.
    expect(scrollContainer.className).not.toContain("wb-markdown-inline");
  });

  it("shows the field label, context title, and markdown badge", () => {
    renderSheet();
    expect(screen.getByText("Acceptance criteria")).toBeInTheDocument();
    expect(
      screen.getByText("Canonicalize Markdown rendering"),
    ).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();
  });

  it("requests close from the Done button", async () => {
    const { onOpenChange } = renderSheet();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
