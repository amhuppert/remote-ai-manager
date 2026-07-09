import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_PRICING, estimateCodexCostUsd } from "./pricing";

describe("estimateCodexCostUsd", () => {
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 10,
    output_tokens: 50,
  };

  it("prices fresh input, cached input, and output separately (cached is a subset of input)", () => {
    // gpt-5.4: $2.50 / $0.25 / $15.00 per 1M
    // 90 fresh * 2.5 + 10 cached * 0.25 + 50 out * 15 = 977.5 micro-dollars
    expect(estimateCodexCostUsd(usage, "gpt-5.4")).toBeCloseTo(0.0009775, 10);
  });

  it("uses the model's own rates", () => {
    // gpt-5.5: $5 / $0.50 / $30 per 1M
    expect(estimateCodexCostUsd(usage, "gpt-5.5")).toBeCloseTo(
      (90 * 5 + 10 * 0.5 + 50 * 30) / 1_000_000,
      10,
    );
  });

  it("prices the GPT-5.6 Sol, Terra, and Luna models", () => {
    // sol: $5 / $0.50 / $30 · terra: $2.50 / $0.25 / $15 · luna: $1 / $0.10 / $6
    expect(estimateCodexCostUsd(usage, "gpt-5.6-sol")).toBeCloseTo(
      (90 * 5 + 10 * 0.5 + 50 * 30) / 1_000_000,
      10,
    );
    expect(estimateCodexCostUsd(usage, "gpt-5.6-terra")).toBeCloseTo(
      (90 * 2.5 + 10 * 0.25 + 50 * 15) / 1_000_000,
      10,
    );
    expect(estimateCodexCostUsd(usage, "gpt-5.6-luna")).toBeCloseTo(
      (90 * 1 + 10 * 0.1 + 50 * 6) / 1_000_000,
      10,
    );
  });

  it("falls back to the default Codex model when modelId is undefined", () => {
    expect(estimateCodexCostUsd(usage, undefined)).toBe(
      estimateCodexCostUsd(usage, "gpt-5.4"),
    );
  });

  it("returns null for a model with no known rates", () => {
    expect(estimateCodexCostUsd(usage, "o3-pro")).toBeNull();
  });

  it("prefers override rates for a model over the defaults", () => {
    const overrides = {
      "gpt-5.4": {
        inputPerMillion: 10,
        cachedInputPerMillion: 1,
        outputPerMillion: 100,
      },
    };
    expect(estimateCodexCostUsd(usage, "gpt-5.4", overrides)).toBeCloseTo(
      (90 * 10 + 10 * 1 + 50 * 100) / 1_000_000,
      10,
    );
  });

  it("overrides can price a model absent from the defaults", () => {
    const overrides = {
      "gpt-6-preview": {
        inputPerMillion: 8,
        cachedInputPerMillion: 0.8,
        outputPerMillion: 40,
      },
    };
    expect(DEFAULT_CODEX_PRICING["gpt-6-preview"]).toBeUndefined();
    expect(estimateCodexCostUsd(usage, "gpt-6-preview", overrides)).toBeCloseTo(
      (90 * 8 + 10 * 0.8 + 50 * 40) / 1_000_000,
      10,
    );
  });

  it("clamps cached tokens to the input total so malformed usage cannot go negative", () => {
    const malformed = {
      input_tokens: 10,
      cached_input_tokens: 50,
      output_tokens: 0,
    };
    // All 10 input tokens priced as cached; no negative fresh-input term.
    expect(estimateCodexCostUsd(malformed, "gpt-5.4")).toBeCloseTo(
      (10 * 0.25) / 1_000_000,
      10,
    );
  });

  it("returns 0 for zero usage on a known model", () => {
    expect(
      estimateCodexCostUsd(
        { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
        "gpt-5.5",
      ),
    ).toBe(0);
  });
});
