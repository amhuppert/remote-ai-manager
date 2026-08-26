import { describe, expect, it } from "vitest";

import { resolveCodexModelSelection } from "./model-selection";

const customSelection = {
  modelId: "company-codex-model",
  parameters: { reasoning: "high", fast: "false" },
};

describe("resolveCodexModelSelection", () => {
  it("rejects an arbitrary custom model when no configured profile authorizes it", () => {
    expect(() => resolveCodexModelSelection(customSelection)).toThrow(
      /not present in this backend catalog/i,
    );
  });

  it("accepts the custom model authorized by the configured Codex profile", () => {
    expect(
      resolveCodexModelSelection(customSelection, customSelection)
        .modelSelection,
    ).toEqual(customSelection);
  });

  it("does not let a different custom candidate synthesize itself beside the configured custom model", () => {
    expect(() =>
      resolveCodexModelSelection(
        {
          modelId: "request-supplied-model",
          parameters: { reasoning: "high", fast: "false" },
        },
        customSelection,
      ),
    ).toThrow(/not present in this backend catalog/i);
  });
});
