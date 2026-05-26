// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CommandIndicator from "./CommandIndicator";

describe("CommandIndicator", () => {
  it("renders the command name and args inline when args has no newline", () => {
    const { container } = render(
      <CommandIndicator name="/collab" args="short single-line argument" />,
    );
    const indicator = container.querySelector(".command-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.classList.contains("command-indicator--expanded")).toBe(
      false,
    );
    expect(screen.getByText("/collab")).toBeDefined();
    expect(screen.getByText("short single-line argument")).toBeDefined();
  });

  it("renders just the command name when args is null", () => {
    const { container } = render(
      <CommandIndicator name="/compact" args={null} />,
    );
    const indicator = container.querySelector(".command-indicator");
    expect(indicator?.classList.contains("command-indicator--expanded")).toBe(
      false,
    );
    expect(screen.getByText("/compact")).toBeDefined();
    expect(container.querySelector(".command-args")).toBeNull();
    expect(container.querySelector(".command-indicator__body")).toBeNull();
  });

  it("renders an expanded markdown body when args contains a newline", async () => {
    const args = "Line one.\n\n**Bold change** and more details.";
    const { container } = render(
      <CommandIndicator name="/collab" args={args} />,
    );
    const indicator = container.querySelector(".command-indicator");
    expect(indicator?.classList.contains("command-indicator--expanded")).toBe(
      true,
    );
    expect(screen.getByText("/collab")).toBeDefined();
    const body = container.querySelector(".command-indicator__body");
    expect(body).not.toBeNull();
    // MarkdownContent is loaded via next/dynamic — wait for it to mount.
    await waitFor(
      () => {
        expect(body?.querySelector("strong")?.textContent).toBe("Bold change");
      },
      { timeout: 5000 },
    );
    expect(container.querySelector(".command-args")).toBeNull();
  });
});
