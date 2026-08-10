// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import SessionsFilterPopover from "./SessionsFilterPopover";
import type { SessionListItem } from "@/lib/sessions/schemas";

afterEach(cleanup);

// The component only reads `derivedStatus` and `targetBranch` off each session.
const sessions = [
  { derivedStatus: "working", targetBranch: "main" },
  { derivedStatus: "idle", targetBranch: "develop" },
] as unknown as SessionListItem[];

describe("SessionsFilterPopover", () => {
  it("opens a labelled floating panel exposing the derived status/target options", () => {
    render(
      <SessionsFilterPopover
        tokens={[]}
        onTokensChange={vi.fn()}
        sessions={sessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("dialog", { name: "Session filters" });
    expect(within(panel).getByText("working")).toBeInTheDocument();
    expect(within(panel).getByText("develop")).toBeInTheDocument();
    expect(within(panel).getByText("Include archived")).toBeInTheDocument();
  });

  it("toggles a status token without closing the panel (multi-select)", () => {
    const onTokensChange = vi.fn();
    render(
      <SessionsFilterPopover
        tokens={[]}
        onTokensChange={onTokensChange}
        sessions={sessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("dialog");
    fireEvent.click(within(panel).getByText("working"));
    expect(onTokensChange).toHaveBeenCalledWith([
      { cat: "status", key: "is", value: "working" },
    ]);
    // Multi-select: the panel stays open after a toggle.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("reflects an active token via aria-pressed", () => {
    render(
      <SessionsFilterPopover
        tokens={[{ cat: "status", key: "is", value: "working" }]}
        onTokensChange={vi.fn()}
        sessions={sessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("dialog");
    expect(within(panel).getByText("working")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(panel).getByText("idle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("closes the panel on Escape", () => {
    render(
      <SessionsFilterPopover
        tokens={[]}
        onTokensChange={vi.fn()}
        sessions={sessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
