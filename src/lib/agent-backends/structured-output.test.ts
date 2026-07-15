/**
 * Behavior tests for the shared structured-output extraction/validation
 * module (design doc Blocker 1 §1.2.1): extraction precedence, fenced-block
 * handling, and validation fall-through across candidates.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  extractStructuredOutput,
  validateStructuredOutput,
} from "./structured-output";

const okSchema = z.object({ ok: z.literal(true) });

describe("extractStructuredOutput — precedence", () => {
  it("prefers native output over raw JSON text", () => {
    const result = extractStructuredOutput({
      native: { ok: true, origin: "native" },
      text: '{"ok":true,"origin":"raw"}',
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true, origin: "native" },
      source: "native",
    });
  });

  it("parses the full text as raw JSON when native is absent", () => {
    const result = extractStructuredOutput({
      text: '{"ok":true,"origin":"raw"}',
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true, origin: "raw" },
      source: "raw_json",
    });
  });

  it("extracts the LAST fenced block when the text is prose with two fences", () => {
    const text = [
      "First attempt:",
      "```json",
      '{"ok":false,"attempt":1}',
      "```",
      "Corrected:",
      "```json",
      '{"ok":true,"attempt":2}',
      "```",
    ].join("\n");
    const result = extractStructuredOutput({ text });
    expect(result).toEqual({
      ok: true,
      value: { ok: true, attempt: 2 },
      source: "fenced",
    });
  });

  it("accepts a bare ``` fence without an info string", () => {
    const text = 'Result below.\n```\n{"ok":true}\n```\n';
    const result = extractStructuredOutput({ text });
    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      source: "fenced",
    });
  });

  it("matches only the named fence when fenceInfo is given", () => {
    const text = [
      "```json",
      '{"ok":false,"origin":"json-fence"}',
      "```",
      "```spawn-proposal",
      '{"ok":true,"origin":"named-fence"}',
      "```",
    ].join("\n");
    const named = extractStructuredOutput(
      { text },
      { fenceInfo: "spawn-proposal" },
    );
    expect(named).toEqual({
      ok: true,
      value: { ok: true, origin: "named-fence" },
      source: "fenced",
    });

    const noMatch = extractStructuredOutput(
      { text: '```json\n{"ok":true}\n```' },
      { fenceInfo: "spawn-proposal" },
    );
    expect(noMatch.ok).toBe(false);
  });
});

describe("extractStructuredOutput — nothing extractable", () => {
  it("reports all attempted sources when text is null", () => {
    const result = extractStructuredOutput({ text: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("native absent");
      expect(result.error).toContain("text absent");
    }
  });

  it("reports all attempted sources when text is prose-only", () => {
    const result = extractStructuredOutput({
      text: "Sorry, no structured response this time.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("native absent");
      expect(result.error).toContain("not JSON");
      expect(result.error).toContain("fenced");
    }
  });
});

describe("validateStructuredOutput", () => {
  it("returns the native value when it passes the schema", () => {
    const result = validateStructuredOutput(okSchema, {
      native: { ok: true },
      text: "irrelevant prose",
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      source: "native",
    });
  });

  it("returns a fenced value when native is absent", () => {
    const result = validateStructuredOutput(okSchema, {
      text: 'Here you go:\n```json\n{"ok":true}\n```\n',
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      source: "fenced",
    });
  });

  // Pins the deliberate fall-through widening (design §1.2.1 item 2 / T1.4):
  // an invalid native candidate falls through to a valid lower-priority one.
  it("falls through to a valid fenced candidate when native fails the schema", () => {
    const result = validateStructuredOutput(okSchema, {
      native: { ok: false },
      text: 'Corrected:\n```json\n{"ok":true}\n```\n',
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      source: "fenced",
    });
  });

  it("falls through native → raw_json", () => {
    const result = validateStructuredOutput(okSchema, {
      native: { ok: false },
      text: '{"ok":true}',
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      source: "raw_json",
    });
  });

  it("reports the highest-priority candidate's issues when every candidate fails", () => {
    const result = validateStructuredOutput(okSchema, {
      native: { ok: "native-wrong" },
      text: '{"ok":"raw-wrong"}',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("validation");
      expect(result.error).toContain("ok");
      expect(result.error).toContain("native");
    }
  });

  it("reports stage extraction when there are no candidates at all", () => {
    const result = validateStructuredOutput(okSchema, {
      text: "prose without any JSON",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("extraction");
    }
  });

  it("applies the schema's transforms to the accepted value", () => {
    const schema = z
      .object({ count: z.string() })
      .transform(({ count }) => ({ count: Number(count) }));
    const result = validateStructuredOutput(schema, {
      text: '{"count":"3"}',
    });
    expect(result).toEqual({
      ok: true,
      value: { count: 3 },
      source: "raw_json",
    });
  });
});
