// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ReadOnlyDocumentSurface from "./ReadOnlyDocumentSurface";

describe("ReadOnlyDocumentSurface", () => {
  it("renders Markdown without comment or feedback controls", async () => {
    render(
      <ReadOnlyDocumentSurface
        content={"# Shared runbook\n\nExternal content."}
        isLoading={false}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Shared runbook" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Comment")).toBeNull();
    expect(screen.queryByText("Send to")).toBeNull();
  });

  it("composes MarkdownViewport with the document adapter and no source mapping", async () => {
    const { container } = render(
      <ReadOnlyDocumentSurface
        content={"# Shared runbook\n\nExternal content."}
        isLoading={false}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-markdown-intent="document"]'),
      ).not.toBeNull();
    });

    // The read-only surface is a MarkdownViewport host over the document adapter.
    expect(container.querySelector("[data-markdown-viewport]")).not.toBeNull();
    // It is not an annotated surface: no source-position metadata is stamped and
    // no annotation gutter is reserved.
    expect(container.querySelector("[data-markdown-source-mapped]")).toBeNull();
    expect(container.querySelector("[data-cc-line]")).toBeNull();
  });

  it("shows the viewport loading state while content is pending", () => {
    const { container } = render(
      <ReadOnlyDocumentSurface content={null} isLoading />,
    );
    const viewport = container.querySelector("[data-markdown-viewport]");
    expect(viewport).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });
});
