import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("workflow-draft/origin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses CC_SERVER_URL when present and strips a trailing slash", async () => {
    process.env.CC_SERVER_URL = "https://cc.example.com/";
    const { getCommandCenterOrigin } = await import("./origin");

    expect(getCommandCenterOrigin()).toBe("https://cc.example.com");
  });

  it("falls back to CC_HOST and PORT", async () => {
    delete process.env.CC_SERVER_URL;
    process.env.CC_HOST = "localhost";
    process.env.PORT = "4321";
    const { getCommandCenterOrigin } = await import("./origin");

    expect(getCommandCenterOrigin()).toBe("http://localhost:4321");
  });

  it("uses 127.0.0.1:3000 by default", async () => {
    delete process.env.CC_SERVER_URL;
    delete process.env.CC_HOST;
    delete process.env.PORT;
    const { getCommandCenterOrigin } = await import("./origin");

    expect(getCommandCenterOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("throws for an invalid CC_SERVER_URL", async () => {
    process.env.CC_SERVER_URL = "not-a-url";
    const { getCommandCenterOrigin } = await import("./origin");

    expect(() => getCommandCenterOrigin()).toThrow(
      "CC server origin must be an absolute http(s) URL",
    );
  });
});
