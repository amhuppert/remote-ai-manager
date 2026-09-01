import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useToastStoreForTesting,
  pushToast,
  dismissToast,
  replaceActionToast,
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

  it("stores an action and keeps actionable toasts until explicit dismissal", () => {
    const onClick = vi.fn();
    pushToast("Couldn't move command-center#9 to Done — rolled back", {
      action: { label: "Retry", onClick },
    });
    const toast = useToastStoreForTesting.getState().toasts[0]!;
    expect(toast.action?.label).toBe("Retry");
    toast.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);

    dismissToast(toast.id);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(0);
  });

  it("stores multiple actions and keeps the toast until explicit dismissal", () => {
    const open = vi.fn();
    const undo = vi.fn();
    pushToast("Clipped to Inbox", {
      actions: [
        { label: "Open", onClick: open },
        { label: "Undo", onClick: undo },
      ],
    });
    const toast = useToastStoreForTesting.getState().toasts[0]!;
    expect(toast.actions?.map((action) => action.label)).toEqual([
      "Open",
      "Undo",
    ]);

    vi.advanceTimersByTime(60_000);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);

    dismissToast(toast.id);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(0);
  });

  it("replaces an actionable toast in place and restores it if already dismissed", () => {
    const viewTicket = vi.fn();
    const openConversation = vi.fn();
    const id = pushToast("command-center#9 created — starting agent…", {
      action: { label: "View ticket", onClick: viewTicket },
    });

    replaceActionToast(id, "Agent queued on command-center#9", {
      label: "Open conversation",
      onClick: openConversation,
    });

    expect(useToastStoreForTesting.getState().toasts).toEqual([
      expect.objectContaining({
        id,
        message: "Agent queued on command-center#9",
        action: expect.objectContaining({ label: "Open conversation" }),
      }),
    ]);

    dismissToast(id);
    replaceActionToast(id, "Agent already active on command-center#9", {
      label: "Open session",
      onClick: vi.fn(),
    });
    expect(useToastStoreForTesting.getState().toasts).toEqual([
      expect.objectContaining({
        id,
        message: "Agent already active on command-center#9",
      }),
    ]);
  });
});
