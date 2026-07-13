// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it } from "vitest";
import MarkdownViewport, {
  type MarkdownViewportProps,
} from "./MarkdownViewport";

describe("MarkdownViewport", () => {
  it("has only loading, empty, overlay, and rendered-child host props", () => {
    expectTypeOf<keyof MarkdownViewportProps>().toEqualTypeOf<
      "isLoading" | "emptyMessage" | "overlay" | "children"
    >();
    expectTypeOf<
      ComponentProps<typeof MarkdownViewport>
    >().toEqualTypeOf<MarkdownViewportProps>();
  });

  it("renders an accessible loading state instead of children or overlay", () => {
    render(
      <MarkdownViewport isLoading overlay={<span>Comment overlay</span>}>
        <span>Loaded document</span>
      </MarkdownViewport>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(screen.queryByText("Loaded document")).toBeNull();
    expect(screen.queryByText("Comment overlay")).toBeNull();
  });

  it("renders the configured empty state when no child is supplied", () => {
    render(
      <MarkdownViewport emptyMessage="No document selected.">
        {null}
      </MarkdownViewport>,
    );

    expect(screen.getByText("No document selected.")).toBeVisible();
  });

  it("composes already-rendered children and an overlay inside its scroll host", () => {
    const { container } = render(
      <MarkdownViewport overlay={<span>Comment overlay</span>}>
        <p>Literal **not parsed here** child</p>
      </MarkdownViewport>,
    );

    const viewport = container.querySelector("[data-markdown-viewport]");
    expect(viewport).toHaveClass(
      "flex-1",
      "overflow-y-auto",
      "overflow-x-hidden",
    );
    expect(viewport).toContainElement(
      screen.getByText("Literal **not parsed here** child"),
    );
    expect(viewport).toContainElement(screen.getByText("Comment overlay"));
    expect(viewport?.querySelector("strong")).toBeNull();
  });
});
