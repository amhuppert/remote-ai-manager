import { describe, expect, it } from "vitest";

import type { ParameterDeclaration } from "@/lib/workflows/schemas";

import { validateLaunchInputs } from "./start-input-service";

function requiredString(
  name: string,
  extra: Partial<Extract<ParameterDeclaration, { type: "string" }>> = {},
): ParameterDeclaration {
  return { type: "string", name, label: name, required: true, ...extra };
}

function optionalString(
  name: string,
  extra: Partial<Extract<ParameterDeclaration, { type: "string" }>> = {},
): ParameterDeclaration {
  return { type: "string", name, label: name, required: false, ...extra };
}

function enumParam(
  name: string,
  options: string[],
  extra: Partial<Extract<ParameterDeclaration, { type: "enum" }>> = {},
): ParameterDeclaration {
  return {
    type: "enum",
    name,
    label: name,
    required: true,
    options,
    ...extra,
  };
}

describe("validateLaunchInputs", () => {
  describe("missing_required", () => {
    it("rejects a required parameter with no default when omitted", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("ticket")],
        supplied: {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("missing_required");
      if (result.error.kind !== "missing_required") {
        throw new Error("expected missing_required");
      }
      expect(result.error.name).toBe("ticket");
    });

    it("rejects a required parameter with no default when undefined payload is supplied", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("ticket")],
        supplied: undefined,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("missing_required");
      if (result.error.kind !== "missing_required") {
        throw new Error("expected missing_required");
      }
      expect(result.error.name).toBe("ticket");
    });

    it("does not classify a required-no-default omission as invalid_value", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("ticket", { minLength: 2 })],
        supplied: {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("missing_required");
    });
  });

  describe("default application (R3.4)", () => {
    it("uses the declared default when the value is omitted", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("scope", { default: "backend" })],
        supplied: {},
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({ scope: "backend" });
    });

    it("uses an enum default when omitted", () => {
      const result = validateLaunchInputs({
        parameters: [
          enumParam("mode", ["fast", "thorough"], { default: "thorough" }),
        ],
        supplied: {},
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({ mode: "thorough" });
    });

    it("prefers a supplied value over the default", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("scope", { default: "backend" })],
        supplied: { scope: "frontend" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({ scope: "frontend" });
    });
  });

  describe("invalid_value (R3.3)", () => {
    it("rejects an enum value outside its options", () => {
      const result = validateLaunchInputs({
        parameters: [enumParam("mode", ["fast", "thorough"])],
        supplied: { mode: "turbo" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("invalid_value");
      if (result.error.kind !== "invalid_value") {
        throw new Error("expected invalid_value");
      }
      expect(result.error.name).toBe("mode");
      expect(result.error.message.length).toBeGreaterThan(0);
    });

    it("rejects a value shorter than the minimum length", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("title", { minLength: 5 })],
        supplied: { title: "ab" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("invalid_value");
      if (result.error.kind !== "invalid_value") {
        throw new Error("expected invalid_value");
      }
      expect(result.error.name).toBe("title");
      expect(result.error.message.length).toBeGreaterThan(0);
    });

    it("rejects a value longer than the maximum length", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("title", { maxLength: 3 })],
        supplied: { title: "toolong" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("invalid_value");
      if (result.error.kind !== "invalid_value") {
        throw new Error("expected invalid_value");
      }
      expect(result.error.name).toBe("title");
    });
  });

  describe("unknown_parameter (R3.5)", () => {
    it("rejects a supplied key that is not a declared parameter", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("ticket")],
        supplied: { ticket: "CC-1", bogus: "x" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("unknown_parameter");
      if (result.error.kind !== "unknown_parameter") {
        throw new Error("expected unknown_parameter");
      }
      expect(result.error.name).toBe("bogus");
    });

    it("rejects an unknown key against a zero-parameter definition", () => {
      const result = validateLaunchInputs({
        parameters: [],
        supplied: { anything: "x" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.error.kind).toBe("unknown_parameter");
      if (result.error.kind !== "unknown_parameter") {
        throw new Error("expected unknown_parameter");
      }
      expect(result.error.name).toBe("anything");
    });
  });

  describe("zero-input definition (R3.6, R10)", () => {
    it("returns empty bound inputs for an undefined payload", () => {
      const result = validateLaunchInputs({
        parameters: [],
        supplied: undefined,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({});
    });

    it("returns empty bound inputs for an empty payload", () => {
      const result = validateLaunchInputs({
        parameters: [],
        supplied: {},
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({});
    });
  });

  describe("no redaction / no secret inspection (R3.7)", () => {
    it("passes a secret-looking string value through unredacted", () => {
      const secret = "sk-live-AKIA1234567890SECRETTOKEN";
      const result = validateLaunchInputs({
        parameters: [requiredString("apiKey")],
        supplied: { apiKey: secret },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs.apiKey).toBe(secret);
    });
  });

  describe("success shape", () => {
    it("returns every required value (supplied or default)", () => {
      const result = validateLaunchInputs({
        parameters: [
          requiredString("ticket"),
          requiredString("scope", { default: "backend" }),
          enumParam("mode", ["fast", "thorough"]),
        ],
        supplied: { ticket: "CC-1", mode: "fast" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({
        ticket: "CC-1",
        scope: "backend",
        mode: "fast",
      });
    });

    it("omits an optional-no-default parameter that was not supplied (absent, not undefined)", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("ticket"), optionalString("note")],
        supplied: { ticket: "CC-1" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({ ticket: "CC-1" });
      expect("note" in result.boundInputs).toBe(false);
    });

    it("includes an optional parameter when it is supplied", () => {
      const result = validateLaunchInputs({
        parameters: [requiredString("ticket"), optionalString("note")],
        supplied: { ticket: "CC-1", note: "hello" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.boundInputs).toEqual({ ticket: "CC-1", note: "hello" });
    });
  });
});
