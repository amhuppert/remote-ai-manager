// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { useLongPress } from "./use-long-press";

function makeTouch(clientX: number, clientY: number): Touch {
  return {
    identifier: 0,
    target: document.body,
    clientX,
    clientY,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 0,
    radiusY: 0,
    rotationAngle: 0,
    force: 1,
  } as Touch;
}

function Harness({
  onLongPress,
  onClick,
}: {
  onLongPress: (point: { x: number; y: number }) => void;
  onClick?: () => void;
}): React.JSX.Element {
  const { handlers, didLongPressRef } = useLongPress({ onLongPress });
  return (
    <div
      data-testid="target"
      {...handlers}
      onClick={() => {
        if (didLongPressRef.current) return;
        onClick?.();
      }}
    >
      target
    </div>
  );
}

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onLongPress after the threshold with touch coordinates", () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Harness onLongPress={onLongPress} />);
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(120, 240)] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).toHaveBeenCalledWith({ x: 120, y: 240 });
  });

  it("does not fire if touch ends before the threshold", () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Harness onLongPress={onLongPress} />);
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(0, 0)] });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.touchEnd(target);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when the touch moves more than the slop distance", () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Harness onLongPress={onLongPress} />);
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(50, 50)] });
    fireEvent.touchMove(target, { touches: [makeTouch(80, 80)] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("ignores small movements within the slop distance", () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Harness onLongPress={onLongPress} />);
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(50, 50)] });
    fireEvent.touchMove(target, { touches: [makeTouch(53, 52)] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("cancels on touchcancel", () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Harness onLongPress={onLongPress} />);
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(0, 0)] });
    fireEvent.touchCancel(target);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("sets didLongPressRef so the consumer can suppress the synthetic click", () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const { getByTestId } = render(
      <Harness onLongPress={onLongPress} onClick={onClick} />,
    );
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(0, 0)] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.touchEnd(target);
    fireEvent.click(target);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("clears didLongPressRef on the next touchstart", () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const { getByTestId } = render(
      <Harness onLongPress={onLongPress} onClick={onClick} />,
    );
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(0, 0)] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.touchEnd(target);

    fireEvent.touchStart(target, { touches: [makeTouch(0, 0)] });
    fireEvent.touchEnd(target);
    fireEvent.click(target);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("supports a custom threshold", () => {
    const onLongPress = vi.fn();
    function CustomHarness(): React.JSX.Element {
      const { handlers } = useLongPress({ onLongPress, thresholdMs: 1000 });
      return <div data-testid="target" {...handlers} />;
    }
    const { getByTestId } = render(<CustomHarness />);
    const target = getByTestId("target");

    fireEvent.touchStart(target, { touches: [makeTouch(0, 0)] });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
