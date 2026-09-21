/**
 * Behavior tests for the shared structured-output extraction/validation
 * module (design doc Blocker 1 §1.2.1): extraction precedence, fenced-block
 * handling, and validation fall-through across candidates.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateStructuredOutput } from "./structured-output";

const okSchema = z.object({ ok: z.literal(true) });

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
