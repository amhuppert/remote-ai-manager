import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isEffectFree } from "./effect-free";

describe("isEffectFree", () => {
  const effectFree: Array<[string, z.ZodType]> = [
    ["plain object", z.object({ a: z.string() })],
    ["nullable field", z.object({ a: z.string().nullable() })],
    ["optional field", z.object({ a: z.string().optional() })],
    ["enum field", z.object({ a: z.enum(["x", "y"]) })],
    ["array field", z.object({ a: z.array(z.string()) })],
    ["record field", z.object({ a: z.record(z.string(), z.number()) })],
    ["top-level union", z.union([z.string(), z.number()])],
    ["nested object", z.object({ a: z.object({ b: z.array(z.string()) }) })],
  ];

  const effectBearing: Array<[string, z.ZodType]> = [
    ["field default", z.object({ a: z.string().default("x") })],
    ["array default", z.object({ a: z.array(z.string()).default([]) })],
    [
      "nested default",
      z.object({ a: z.object({ b: z.string().default("x") }) }),
    ],
    ["object transform", z.object({ a: z.string() }).transform((o) => o)],
    ["field transform", z.object({ a: z.string().transform((s) => s) })],
    ["preprocess", z.preprocess((v) => v, z.string())],
    ["coerce", z.coerce.number()],
    ["catch", z.object({ a: z.string().catch("x") })],
    ["union with default branch", z.union([z.string(), z.number().default(0)])],
  ];

  it.each(effectFree)("treats %s as effect-free", (_name, schema) => {
    expect(isEffectFree(schema)).toBe(true);
  });

  it.each(effectBearing)("treats %s as effect-bearing", (_name, schema) => {
    expect(isEffectFree(schema)).toBe(false);
  });
});
