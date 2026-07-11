// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReadOnlyDocumentSurface from "./ReadOnlyDocumentSurface";

describe("ReadOnlyDocumentSurface", () => {
  it("renders Markdown without comment or feedback controls", () => {
    render(
      <ReadOnlyDocumentSurface
        content={"# Shared runbook\n\nExternal content."}
        isLoading={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Shared runbook" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Comment")).toBeNull();
    expect(screen.queryByText("Send to")).toBeNull();
  });
});
