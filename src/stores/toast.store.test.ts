import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useToastStoreForTesting,
  pushToast,
  dismissToast,
} from "./toast.store";

describe("toast.store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStoreForTesting.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends a toast with a unique id and the given message on push", () => {
    pushToast("Saved");
    pushToast("Deleted");
    const { toasts } = useToastStoreForTesting.getState();
    expect(toasts).toHaveLength(2);
    expect(toasts[0]?.message).toBe("Saved");
    expect(toasts[1]?.message).toBe("Deleted");
    expect(toasts[0]?.id).not.toBe(toasts[1]?.id);
  });

  it("auto-dismisses a toast after 2200ms", () => {
    pushToast("Ephemeral");
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2199);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(0);
  });

  it("dismissToast removes by id without affecting others", () => {
    pushToast("A");
    pushToast("B");
    const targetId = useToastStoreForTesting.getState().toasts[0]!.id;
    dismissToast(targetId);
    const remaining = useToastStoreForTesting.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.message).toBe("B");
  });

  it("dismissing an unknown id is a no-op", () => {
    pushToast("A");
    dismissToast("ghost");
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);
  });

  it("stores an action and keeps actionable toasts up for 6000ms", () => {
    const onClick = vi.fn();
    pushToast("Couldn't move command-center#9 to Done — rolled back", {
      action: { label: "Retry", onClick },
    });
    const toast = useToastStoreForTesting.getState().toasts[0]!;
    expect(toast.action?.label).toBe("Retry");
    toast.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5999);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(0);
  });
});
