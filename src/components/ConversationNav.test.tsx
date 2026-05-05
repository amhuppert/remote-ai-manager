// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
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
  // Buttons are always enabled
  // -------------------------------------------------------------------------

  it("keeps all buttons enabled when conversation is empty", () => {
    render(<ConversationNav currentIndex={0} totalCount={0} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(last).not.toBeDisabled();
  });

  it("keeps all buttons enabled at the first message", () => {
    render(<ConversationNav currentIndex={0} totalCount={5} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(last).not.toBeDisabled();
  });

  it("keeps all buttons enabled at the last message", () => {
    render(<ConversationNav currentIndex={4} totalCount={5} {...handlers} />);
    const { first, prev, next, last } = getButtons();
    expect(first).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(last).not.toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Counter display
  // -------------------------------------------------------------------------

  it("shows '0 / 0' when empty", () => {
    render(<ConversationNav currentIndex={0} totalCount={0} {...handlers} />);
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });

  it("shows 1-indexed counter for current position", () => {
    render(<ConversationNav currentIndex={4} totalCount={12} {...handlers} />);
    expect(screen.getByText("5 / 12")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Click handlers fire
  // -------------------------------------------------------------------------

  it("fires onFirst when first button clicked", () => {
    const onFirst = vi.fn();
    render(
      <ConversationNav
        currentIndex={2}
        totalCount={5}
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
        currentIndex={2}
        totalCount={5}
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
        currentIndex={2}
        totalCount={5}
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
        currentIndex={2}
        totalCount={5}
        {...handlers}
        onLast={onLast}
      />,
    );
    fireEvent.click(screen.getByTitle("Last message"));
    expect(onLast).toHaveBeenCalledTimes(1);
  });

  it("fires handlers even at boundary positions", () => {
    const onFirst = vi.fn();
    const onPrevious = vi.fn();
    render(
      <ConversationNav
        currentIndex={0}
        totalCount={5}
        {...handlers}
        onFirst={onFirst}
        onPrevious={onPrevious}
      />,
    );
    fireEvent.click(screen.getByTitle("First message"));
    fireEvent.click(screen.getByTitle("Previous message"));
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });
});
