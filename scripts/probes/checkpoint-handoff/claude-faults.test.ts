import { describe, expect, it } from "vitest";
import { rejectArmedHookSuppression } from "./claude-faults";

describe("explicit Claude setup-control fault", () => {
  it("rejects the armed suppression boundary without forwarding it and preserves ordinary settings", async () => {
    let armed = false;
    let forwarded = 0;
    let rejected = 0;
    const control = rejectArmedHookSuppression(
      async () => {
        forwarded++;
      },
      () => armed,
      async () => {
        rejected++;
      },
    );
    await control({ disableAllHooks: true });
    armed = true;
    await control({ disableAllHooks: false });
    await expect(control({ disableAllHooks: true })).rejects.toThrow(
      "explicit probe injection: hook suppression rejected before SDK dispatch",
    );
    expect(forwarded).toBe(2);
    expect(rejected).toBe(1);
  });
});
