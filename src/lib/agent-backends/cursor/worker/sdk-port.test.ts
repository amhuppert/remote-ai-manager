import { describe, expect, it } from "vitest";

import { toCursorModelSelection } from "./sdk-port";

describe("toCursorModelSelection", () => {
  it("translates the complete parameter record in stable key order", () => {
    expect(
      toCursorModelSelection({
        modelId: "claude-opus-5",
        parameters: {
          context: "1m",
          cyber: "false",
          effort: "high",
          fast: "false",
          thinking: "true",
        },
      }),
    ).toEqual({
      id: "claude-opus-5",
      params: [
        { id: "context", value: "1m" },
        { id: "cyber", value: "false" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
        { id: "thinking", value: "true" },
      ],
    });
  });

  it("keeps an explicit empty parameter array for parameterless models", () => {
    expect(
      toCursorModelSelection({ modelId: "default", parameters: {} }),
    ).toEqual({ id: "default", params: [] });
  });
});
