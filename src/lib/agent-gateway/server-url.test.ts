import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetServerBaseUrlForTesting,
  getServerBaseUrl,
  recordServerBaseUrl,
  resolveServerBaseUrl,
} from "./server-url";

describe("resolveServerBaseUrl", () => {
  it("derives the loopback URL from PORT", () => {
    expect(resolveServerBaseUrl({ PORT: "3105" })).toBe(
      "http://127.0.0.1:3105",
    );
  });

  it("falls back to port 3000 when PORT is unset or empty", () => {
    expect(resolveServerBaseUrl({})).toBe("http://127.0.0.1:3000");
    expect(resolveServerBaseUrl({ PORT: "" })).toBe("http://127.0.0.1:3000");
  });
});

describe("recordServerBaseUrl / getServerBaseUrl", () => {
  beforeEach(() => {
    _resetServerBaseUrlForTesting();
  });

  it("returns null before boot records the URL", () => {
    expect(getServerBaseUrl()).toBeNull();
  });

  it("returns the recorded URL after boot", () => {
    recordServerBaseUrl({ PORT: "3200" });
    expect(getServerBaseUrl()).toBe("http://127.0.0.1:3200");
  });
});
