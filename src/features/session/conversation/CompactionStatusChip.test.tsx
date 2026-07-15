// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CompactionStatusChip from "./CompactionStatusChip";

afterEach(cleanup);

describe("CompactionStatusChip — labels + activation", () => {
  it("renders the none label and opens the artifact panel on click", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<CompactionStatusChip state={{ kind: "none" }} onOpen={onOpen} />);
    const el = screen.getByRole("button", {
      name: "Context artifact: No compact",
    });
    await user.click(el);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the stale label with its behind count", () => {
    render(
      <CompactionStatusChip
        state={{ kind: "stale", behind: 7 }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Stale (behind 7)");
  });
});

describe("CompactionStatusChip — state-specific affordances", () => {
  it("none is a dashed transparent ghost that promotes to cyan on hover", () => {
    render(<CompactionStatusChip state={{ kind: "none" }} onOpen={() => {}} />);
    const el = screen.getByRole("button");
    expect(el).toHaveClass("border-dashed", "bg-transparent");
    expect(el).toHaveClass("hover:border-cyan", "hover:text-cyan");
    expect(el).not.toHaveClass("border-solid");
  });

  it("pending is a borderless cyan flat accent", () => {
    render(
      <CompactionStatusChip state={{ kind: "pending" }} onOpen={() => {}} />,
    );
    const el = screen.getByRole("button");
    expect(el).toHaveClass("border-0", "bg-cyan-glow", "text-cyan");
    expect(el).not.toHaveClass("border-solid");
  });

  it("fresh is a borderless green flat accent", () => {
    render(
      <CompactionStatusChip state={{ kind: "fresh" }} onOpen={() => {}} />,
    );
    const el = screen.getByRole("button");
    expect(el).toHaveClass("border-0", "bg-green-glow", "text-green");
  });

  it("failed is a borderless red flat accent", () => {
    render(
      <CompactionStatusChip state={{ kind: "failed" }} onOpen={() => {}} />,
    );
    const el = screen.getByRole("button");
    expect(el).toHaveClass("border-0", "bg-red-glow", "text-red");
  });
});
