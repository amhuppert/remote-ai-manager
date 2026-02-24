// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConversationNav from "./ConversationNav";

describe("ConversationNav", () => {
  const handlers = {
    onFirst: vi.fn(),
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onLast: vi.fn(),
  };

  function getButtons() {
    return {
      first: screen.getByTitle("First message"),
      prev: screen.getByTitle("Previous message"),
      next: screen.getByTitle("Next message"),
      last: screen.getByTitle("Last message"),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Disabled-state logic (the regression target)
  // -------------------------------------------------------------------------

  it("disables all buttons when conversation is empty", () => {
    render(<ConversationNav currentTurn={0} totalTurns={0} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).toBeDisabled();
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled();
    expect(last).toBeDisabled();
  });

  it("disables all buttons when there is a single turn", () => {
    render(<ConversationNav currentTurn={0} totalTurns={1} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).toBeDisabled();
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled();
    expect(last).toBeDisabled();
  });

  it("disables only backward buttons at the first turn", () => {
    render(<ConversationNav currentTurn={0} totalTurns={5} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).toBeDisabled();
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(last).not.toBeDisabled();
  });

  it("disables only forward buttons at the last turn", () => {
    render(<ConversationNav currentTurn={4} totalTurns={5} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    expect(next).toBeDisabled();
    expect(last).toBeDisabled();
  });

  it("enables all buttons when in the middle of a conversation", () => {
    render(<ConversationNav currentTurn={2} totalTurns={5} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(last).not.toBeDisabled();
  });

  it("enables all buttons at turn 1 of many (not at boundary)", () => {
    render(<ConversationNav currentTurn={1} totalTurns={10} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(last).not.toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // isAtStart / isAtEnd prop overrides
  // -------------------------------------------------------------------------

  it("respects isAtStart override even when turn > 0", () => {
    render(
      <ConversationNav
        currentTurn={3}
        totalTurns={5}
        isAtStart={true}
        {...handlers}
      />,
    );
    const { first, prev } = getButtons();
    expect(first).toBeDisabled();
    expect(prev).toBeDisabled();
  });

  it("respects isAtEnd override even when not at last turn", () => {
    render(
      <ConversationNav
        currentTurn={1}
        totalTurns={5}
        isAtEnd={true}
        {...handlers}
      />,
    );
    const { next, last } = getButtons();
    expect(next).toBeDisabled();
    expect(last).toBeDisabled();
  });

  it("override false keeps buttons enabled at boundary", () => {
    render(
      <ConversationNav
        currentTurn={0}
        totalTurns={5}
        isAtStart={false}
        {...handlers}
      />,
    );
    const { first, prev } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Counter display
  // -------------------------------------------------------------------------

  it("shows '0 / 0' when empty", () => {
    render(<ConversationNav currentTurn={0} totalTurns={0} {...handlers} />);
    expect(screen.getByText("0 / 0")).toBeDefined();
  });

  it("shows 1-indexed counter for current position", () => {
    render(<ConversationNav currentTurn={4} totalTurns={12} {...handlers} />);
    expect(screen.getByText("5 / 12")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Click handlers fire
  // -------------------------------------------------------------------------

  it("fires onFirst when first button clicked", () => {
    const onFirst = vi.fn();
    render(
      <ConversationNav
        currentTurn={2}
        totalTurns={5}
        {...handlers}
        onFirst={onFirst}
      />,
    );
    fireEvent.click(screen.getByTitle("First message"));
    expect(onFirst).toHaveBeenCalledTimes(1);
  });

  it("fires onPrevious when previous button clicked", () => {
    const onPrevious = vi.fn();
    render(
      <ConversationNav
        currentTurn={2}
        totalTurns={5}
        {...handlers}
        onPrevious={onPrevious}
      />,
    );
    fireEvent.click(screen.getByTitle("Previous message"));
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it("fires onNext when next button clicked", () => {
    const onNext = vi.fn();
    render(
      <ConversationNav
        currentTurn={2}
        totalTurns={5}
        {...handlers}
        onNext={onNext}
      />,
    );
    fireEvent.click(screen.getByTitle("Next message"));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("fires onLast when last button clicked", () => {
    const onLast = vi.fn();
    render(
      <ConversationNav
        currentTurn={2}
        totalTurns={5}
        {...handlers}
        onLast={onLast}
      />,
    );
    fireEvent.click(screen.getByTitle("Last message"));
    expect(onLast).toHaveBeenCalledTimes(1);
  });

  it("does not fire handlers on disabled buttons", () => {
    const onFirst = vi.fn();
    const onPrevious = vi.fn();
    render(
      <ConversationNav
        currentTurn={0}
        totalTurns={5}
        {...handlers}
        onFirst={onFirst}
        onPrevious={onPrevious}
      />,
    );
    fireEvent.click(screen.getByTitle("First message"));
    fireEvent.click(screen.getByTitle("Previous message"));
    expect(onFirst).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
  });
});
