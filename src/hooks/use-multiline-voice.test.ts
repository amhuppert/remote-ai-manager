import { describe, expect, it, vi } from "vitest";
import { createVoiceOwnership } from "./use-multiline-voice";

describe("voice ownership", () => {
  it("claims synchronously and refuses a second recorder while the first is starting", () => {
    const ownership = createVoiceOwnership();
    const stopFirst = vi.fn();

    expect(ownership.claim({ id: "first", stop: stopFirst })).toBe(true);
    expect(ownership.claim({ id: "second", stop: vi.fn() })).toBe(false);
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(ownership.currentId()).toBe("first");
  });

  it("releases only the current owner", () => {
    const ownership = createVoiceOwnership();
    ownership.claim({ id: "first", stop: vi.fn() });

    ownership.release("second");
    expect(ownership.currentId()).toBe("first");
    ownership.release("first");
    expect(ownership.currentId()).toBeNull();
  });
});
