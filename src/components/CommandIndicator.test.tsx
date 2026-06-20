// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CommandIndicator from "./CommandIndicator";

// Behavior, not appearance: the inline-vs-expanded split is keyed on whether
// `args` is multi-line. `.command-indicator__body` is the preserved markdown
// container (generated react-markdown output) and is the one surviving hook that
// distinguishes the two modes; appearance is utility-owned and not asserted here.
describe("CommandIndicator", () => {
  it("renders the command name and args inline when args has no newline", () => {
    const { container } = render(
      <CommandIndicator name="/collab" args="short single-line argument" />,
    );
    expect(screen.getByText("/collab")).toBeDefined();
    expect(screen.getByText("short single-line argument")).toBeDefined();
    expect(container.querySelector(".command-indicator__body")).toBeNull();
  });

  it("renders just the command name when args is null", () => {
    const { container } = render(
      <CommandIndicator name="/compact" args={null} />,
    );
    expect(screen.getByText("/compact")).toBeDefined();
    expect(container.querySelector(".command-indicator__body")).toBeNull();
  });

  it("renders an expanded markdown body when args contains a newline", async () => {
    const args = "Line one.\n\n**Bold change** and more details.";
    const { container } = render(
      <CommandIndicator name="/collab" args={args} />,
    );
    expect(screen.getByText("/collab")).toBeDefined();
    const body = container.querySelector(".command-indicator__body");
    expect(body).not.toBeNull();
    // MarkdownContent is loaded via next/dynamic — wait for it to mount.
    // Cold-load of the dynamic chunk can exceed the 1000ms default timeout
    // under parallel test-suite load.
    await waitFor(
      () => {
        expect(body?.querySelector("strong")?.textContent).toBe("Bold change");
      },
      { timeout: 15000 },
    );
  });
});
