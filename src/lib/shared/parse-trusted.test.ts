import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  getTrustedSchemaRegistry,
  parseTrusted,
  registerTrustedSchema,
  revalidateTrusted,
} from "./parse-trusted";

const fooSchema = registerTrustedSchema(
  z.object({ a: z.string() }),
  "fooSchema(test)",
);

const throwingOnInvalid = (message: string) =>
  vi.fn((_issues: z.core.$ZodIssue[]): never => {
    throw new Error(message);
  });

describe("parse-trusted", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("parseTrusted", () => {
    it("returns data as-is in production without invoking the schema", () => {
      vi.stubEnv("NODE_ENV", "production");
      const safeParseSpy = vi.spyOn(fooSchema, "safeParse");
      const parseSpy = vi.spyOn(fooSchema, "parse");
      const invalid = { a: 123 };

      const result = parseTrusted(fooSchema, invalid);

      expect(result).toBe(invalid);
      expect(safeParseSpy).not.toHaveBeenCalled();
      expect(parseSpy).not.toHaveBeenCalled();
    });

    it("parses and returns validated data outside production", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(parseTrusted(fooSchema, { a: "hello" })).toEqual({ a: "hello" });
    });

    it("throws ZodError on invalid data outside production when no onInvalid is given", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(() => parseTrusted(fooSchema, { a: 1 })).toThrow(z.ZodError);
    });

    it("invokes onInvalid on invalid data outside production", () => {
      vi.stubEnv("NODE_ENV", "test");
      const onInvalid = throwingOnInvalid("custom");
      expect(() => parseTrusted(fooSchema, { a: 1 }, onInvalid)).toThrow(
        "custom",
      );
      expect(onInvalid).toHaveBeenCalledOnce();
    });

    it("throws when given an unregistered schema outside production", () => {
      vi.stubEnv("NODE_ENV", "test");
      const unregistered = z.object({ b: z.string() });
      expect(() => parseTrusted(unregistered, { b: "x" })).toThrow(
        /unregistered schema/,
      );
    });

    it("re-reads NODE_ENV per call", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(parseTrusted(fooSchema, { a: 1 })).toEqual({ a: 1 });
      vi.stubEnv("NODE_ENV", "test");
      expect(() => parseTrusted(fooSchema, { a: 1 })).toThrow(z.ZodError);
    });
  });

  describe("revalidateTrusted", () => {
    const barSchema = z.object({ a: z.string().default("x") });

    it("returns data as-is in production without invoking the schema", () => {
      vi.stubEnv("NODE_ENV", "production");
      const parseSpy = vi.spyOn(barSchema, "parse");
      const safeParseSpy = vi.spyOn(barSchema, "safeParse");
      const invalid = { a: 5 };

      expect(revalidateTrusted(barSchema, invalid)).toBe(invalid);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(safeParseSpy).not.toHaveBeenCalled();
    });

    it("does not require registry membership (effect-bearing schema allowed)", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(revalidateTrusted(barSchema, { a: "hi" })).toEqual({ a: "hi" });
    });

    it("uses schema.parse when no onInvalid (throws ZodError on invalid)", () => {
      vi.stubEnv("NODE_ENV", "test");
      const parseSpy = vi.spyOn(barSchema, "parse");
      revalidateTrusted(barSchema, { a: "hi" });
      expect(parseSpy).toHaveBeenCalledOnce();
      expect(() => revalidateTrusted(barSchema, { a: 5 })).toThrow(z.ZodError);
    });

    it("uses safeParse + onInvalid when provided", () => {
      vi.stubEnv("NODE_ENV", "test");
      const onInvalid = throwingOnInvalid("bad");
      expect(() => revalidateTrusted(barSchema, { a: 5 }, onInvalid)).toThrow(
        "bad",
      );
      expect(onInvalid).toHaveBeenCalledOnce();
    });
  });

  describe("registry", () => {
    it("registerTrustedSchema returns the same reference and records it", () => {
      const schema = z.object({ c: z.number() });
      expect(registerTrustedSchema(schema, "schema(test)")).toBe(schema);
      expect(getTrustedSchemaRegistry().has(schema)).toBe(true);
      expect(getTrustedSchemaRegistry().get(schema)).toBe("schema(test)");
    });
  });
});
