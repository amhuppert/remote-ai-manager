import { describe, expect, it } from "vitest";
import {
  CLAUDE_NATIVE_MEMORY_SETTINGS,
  createClaudeNativeMemoryCheck,
} from "./native-memory";

describe("Claude native-memory launch flags", () => {
  it("checks the flag tier once across launches", () => {
    let reads = 0;
    const check = createClaudeNativeMemoryCheck(() => {
      reads += 1;
      return CLAUDE_NATIVE_MEMORY_SETTINGS;
    });
    check();
    check();
    expect(reads).toBe(1);
    expect(CLAUDE_NATIVE_MEMORY_SETTINGS).toEqual({
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
    });
  });

  it("retains an unreadable flag failure for every launch", () => {
    let reads = 0;
    const check = createClaudeNativeMemoryCheck(() => {
      reads += 1;
      return {};
    });
    expect(check).toThrow(/unreadable/);
    expect(check).toThrow(/unreadable/);
    expect(reads).toBe(1);
  });

  it("reports a flag reader failure as unreadable", () => {
    const check = createClaudeNativeMemoryCheck(() => {
      throw new Error("bad settings");
    });
    expect(check).toThrow(/unreadable.*bad settings/);
  });
});
