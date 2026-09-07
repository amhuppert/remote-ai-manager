import { describe, it, expect } from "vitest";
import { DEBUG_MODE_INSTRUCTIONS } from "./prompt-policy";

// ===========================================================================
// Tests
// ===========================================================================

describe("DEBUG_MODE_INSTRUCTIONS", () => {
  // The receiver drops any request carrying X-CC-Debug-Log: 1 as `self_log`.
  // The header is ONLY useful when the project under debug is Command Center
  // itself — it breaks recursion on the debug-log path. For every other
  // project, sending the header silently discards every probe entry, which
  // is what happened during the May 2026 end-to-end flow test.
  it("scopes the X-CC-Debug-Log header to the self-debug-CC case", () => {
    if (!DEBUG_MODE_INSTRUCTIONS.includes("X-CC-Debug-Log")) return;
    expect(DEBUG_MODE_INSTRUCTIONS).toMatch(
      /Command Center itself|self-debug|debugging CC/i,
    );
  });
});
