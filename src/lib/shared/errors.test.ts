import { describe, expect, it } from "vitest";
import {
  PersistenceError,
  type PersistenceFailure,
  getErrorMessage,
} from "./errors";

describe("getErrorMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(getErrorMessage("plain")).toBe("plain");
    expect(getErrorMessage(42)).toBe("42");
  });
});

describe("PersistenceError", () => {
  it("constructs from a validation failure and exposes the kind discriminator", () => {
    const failure: PersistenceFailure = {
      kind: "validation",
      entity: "session",
      identifier: "demo::main",
      issues: [{ path: ["name"], message: "required" }],
    };
    const err = new PersistenceError(failure);
    expect(err).toBeInstanceOf(Error);
    expect(err.failure.kind).toBe("validation");
    if (err.failure.kind === "validation") {
      expect(err.failure.entity).toBe("session");
      expect(err.failure.identifier).toBe("demo::main");
    }
  });

  it("constructs from a not_found failure", () => {
    const err = new PersistenceError({
      kind: "not_found",
      entity: "conversation",
      identifier: "abc-123",
    });
    expect(err.failure.kind).toBe("not_found");
    if (err.failure.kind === "not_found") {
      expect(err.failure.entity).toBe("conversation");
      expect(err.failure.identifier).toBe("abc-123");
    }
  });

  it("constructs from a constraint failure", () => {
    const err = new PersistenceError({
      kind: "constraint",
      constraint: "mutateSession_sibling_session_out_of_scope",
      entity: "session",
      identifier: "demo::main",
    });
    expect(err.failure.kind).toBe("constraint");
    if (err.failure.kind === "constraint") {
      expect(err.failure.constraint).toBe(
        "mutateSession_sibling_session_out_of_scope",
      );
      expect(err.failure.entity).toBe("session");
    }
  });

  it("constructs from an io failure carrying an underlying cause", () => {
    const cause = new Error("disk full");
    const err = new PersistenceError({ kind: "io", cause });
    expect(err.failure.kind).toBe("io");
    if (err.failure.kind === "io") {
      expect(err.failure.cause).toBe(cause);
    }
  });

  it("can be thrown and caught while preserving the discriminated union", () => {
    const failure: PersistenceFailure = {
      kind: "not_found",
      entity: "session",
      identifier: "missing",
    };
    let caught: unknown;
    try {
      throw new PersistenceError(failure);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    if (caught instanceof PersistenceError) {
      expect(caught.failure).toEqual(failure);
    }
  });

  it("uses the failure kind in the constructed Error message", () => {
    const err = new PersistenceError({ kind: "io", cause: "raw string" });
    expect(err.message).toContain("io");
  });
});
