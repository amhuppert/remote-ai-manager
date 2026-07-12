import { describe, expect, it } from "vitest";

import { quoteAgentCommandArgument } from "./command-arguments";

describe("quoteAgentCommandArgument", () => {
  it("quotes every dynamic argument, including simple values", () => {
    expect(quoteAgentCommandArgument("command-center#12")).toBe(
      "'command-center#12'",
    );
  });

  it("preserves spaces and neutralizes shell metacharacters and apostrophes", () => {
    expect(
      quoteAgentCommandArgument("Feature work; $(touch /tmp/pwned) 'owner'"),
    ).toBe("'Feature work; $(touch /tmp/pwned) '\"'\"'owner'\"'\"''");
  });
});
