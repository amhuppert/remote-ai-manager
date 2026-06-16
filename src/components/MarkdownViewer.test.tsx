// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownViewer from "./MarkdownViewer";

describe("MarkdownViewer", () => {
  it("renders links that open in a new tab with a safe rel", () => {
    const md = "See [Example](https://example.com) for details.";
    const { container } = render(
      <MarkdownViewer content={md} isLoading={false} />,
    );

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    const rel = link?.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });
});
