import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildChildEnv } from "./child-env";

describe("buildChildEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("strips NODE_ENV", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const env = buildChildEnv();
    expect(env.NODE_ENV).toBeUndefined();
  });

  it("strips __NEXT_ prefixed vars", () => {
    process.env.__NEXT_FOO = "bar";
    const env = buildChildEnv();
    expect(env.__NEXT_FOO).toBeUndefined();
  });

  it("strips __TURBOPACK_ prefixed vars", () => {
    process.env.__TURBOPACK_FOO = "bar";
    const env = buildChildEnv();
    expect(env.__TURBOPACK_FOO).toBeUndefined();
  });

  it("strips NODE_CHANNEL_ prefixed vars", () => {
    process.env.NODE_CHANNEL_FD = "3";
    const env = buildChildEnv();
    expect(env.NODE_CHANNEL_FD).toBeUndefined();
  });
});
