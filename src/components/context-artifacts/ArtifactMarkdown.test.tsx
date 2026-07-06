// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import ArtifactMarkdown from "./ArtifactMarkdown";

describe("ArtifactMarkdown", () => {
  it("renders '###' as a real heading element, not literal hashes", () => {
    render(<ArtifactMarkdown content={"### What shipped\n\nBody text."} />);
    const heading = screen.getByRole("heading", { name: "What shipped" });
    expect(heading.tagName).toBe("H3");
    // The raw markdown markers must not leak into the rendered text.
    expect(screen.queryByText(/### What shipped/)).not.toBeInTheDocument();
  });

  it("renders backtick spans as <code>, not literal backticks", () => {
    render(
      <ArtifactMarkdown content={"Persisted through `repo.ts` cleanly."} />,
    );
    const code = screen.getByText("repo.ts");
    expect(code.tagName).toBe("CODE");
    expect(screen.queryByText(/`repo.ts`/)).not.toBeInTheDocument();
  });

  it("renders a markdown bullet list as <ul>/<li>", () => {
    render(<ArtifactMarkdown content={"- first item\n- second item"} />);
    const first = screen.getByText("first item");
    expect(first.closest("li")).not.toBeNull();
    expect(first.closest("ul")).not.toBeNull();
    expect(screen.getByText("second item").closest("li")).not.toBe(
      first.closest("li"),
    );
  });

  it("renders '**bold**' as <strong>", () => {
    render(<ArtifactMarkdown content={"A **synthetic lane** ran it."} />);
    const strong = screen.getByText("synthetic lane");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders links that open safely in a new tab", () => {
    render(
      <ArtifactMarkdown content={"See [the docs](https://example.com)."} />,
    );
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders a fenced code block as a <pre> and keeps its text", () => {
    render(<ArtifactMarkdown content={"```\nbun run typecheck\n```"} />);
    const code = screen.getByText("bun run typecheck");
    expect(code.closest("pre")).not.toBeNull();
  });
});
