import { describe, expect, it } from "vitest";

import {
  BUILD_MISMATCH_HEADER,
  BUILD_SKEW_CODE,
  buildMismatchHeaderValue,
  parseBuildMismatchHeader,
} from "./build-parity";

describe("buildMismatchHeaderValue", () => {
  it("returns null when the caller states the server's own build", () => {
    expect(buildMismatchHeaderValue("sha-1", "sha-1")).toBeNull();
  });

  it("returns null when the caller states no build at all", () => {
    // Browsers and curl reach the same endpoints; only a cctl invocation
    // carries the header, and only it can be holding the wrong binary.
    expect(buildMismatchHeaderValue(null, "sha-1")).toBeNull();
  });

  it("names both builds when they differ", () => {
    expect(buildMismatchHeaderValue("cli-2", "server-1")).toBe(
      "server=server-1 cli=cli-2",
    );
  });
});

describe("parseBuildMismatchHeader", () => {
  it("round-trips the value it emits", () => {
    const value = buildMismatchHeaderValue("cli-2", "server-1");
    expect(value).not.toBeNull();
    if (value === null) return;
    expect(parseBuildMismatchHeader(value)).toEqual({
      serverBuild: "server-1",
      cliBuild: "cli-2",
    });
  });

  it("returns null for a value it did not emit", () => {
    expect(parseBuildMismatchHeader("garbage")).toBeNull();
  });
});

describe("BUILD_MISMATCH_HEADER", () => {
  it("is the header name both sides already agreed on", () => {
    expect(BUILD_MISMATCH_HEADER).toBe("x-cc-build-mismatch");
  });
});

describe("BUILD_SKEW_CODE", () => {
  it("is the refusal code the middleware emits and the CLI exits 4 on", () => {
    // Changing this string silently downgrades a skewed mutation refusal to a
    // generic 409 (exit 1) on any binary that still expects the old spelling.
    expect(BUILD_SKEW_CODE).toBe("build_skew");
  });
});
