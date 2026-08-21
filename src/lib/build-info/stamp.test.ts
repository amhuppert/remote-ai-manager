import { describe, expect, it } from "vitest";
import {
  buildInfoSchema,
  formatBuildStamp,
  pinBuildIdentity,
  renderBuildInfoModule,
  toVersionResponse,
  versionResponseSchema,
  type BuildIdentityPin,
} from "./stamp";

describe("formatBuildStamp", () => {
  it("joins sha and build time into a single stamp", () => {
    expect(
      formatBuildStamp({
        sha: "abc1234",
        buildTime: "2026-07-02T10:00:00.000Z",
        message: "feat: add version endpoint",
      }),
    ).toBe("abc1234-2026-07-02T10:00:00.000Z");
  });
});

describe("renderBuildInfoModule", () => {
  it("renders a TS module whose BUILD_INFO round-trips the input", () => {
    const info = {
      sha: "abc1234",
      buildTime: "2026-07-02T10:00:00.000Z",
      message: "feat: add version endpoint",
    };
    const source = renderBuildInfoModule(info);

    expect(source).toContain("export const BUILD_INFO");
    expect(source).toContain('"abc1234"');
    expect(source).toContain('"2026-07-02T10:00:00.000Z"');
    expect(source).toContain('"feat: add version endpoint"');
    expect(source).toContain("do not edit");
  });

  it("escapes values so arbitrary strings cannot break the module source", () => {
    const source = renderBuildInfoModule({
      sha: 'x"; process.exit(1); //',
      buildTime: "t",
      message: "m",
    });
    expect(source).toContain(String.raw`"x\"; process.exit(1); //"`);
  });

  it("encodes a multi-line commit message as a single escaped string literal", () => {
    const source = renderBuildInfoModule({
      sha: "abc1234",
      buildTime: "t",
      message: "subject line\n\nbody paragraph",
    });
    expect(source).toContain(String.raw`"subject line\n\nbody paragraph"`);
  });
});

describe("toVersionResponse", () => {
  it("projects build info onto the wire shape with a joined stamp", () => {
    const response = toVersionResponse({
      sha: "abc1234",
      buildTime: "2026-07-02T10:00:00.000Z",
      message: "feat: add version endpoint",
    });

    expect(response).toEqual({
      sha: "abc1234",
      buildTime: "2026-07-02T10:00:00.000Z",
      message: "feat: add version endpoint",
      stamp: "abc1234-2026-07-02T10:00:00.000Z",
    });
  });

  it("keeps the commit message out of the header-safe stamp", () => {
    const response = toVersionResponse({
      sha: "abc1234",
      buildTime: "2026-07-02T10:00:00.000Z",
      message: "feat: spaces and\nnewlines",
    });

    expect(response.stamp).toBe("abc1234-2026-07-02T10:00:00.000Z");
  });

  it("produces output that satisfies versionResponseSchema", () => {
    const response = toVersionResponse({
      sha: "deadbee",
      buildTime: "2026-07-02T10:00:00.000Z",
      message: "fix: something",
    });

    expect(versionResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe("pinBuildIdentity", () => {
  const booted = {
    sha: "abc1234",
    buildTime: "2026-08-21T18:00:10.164Z",
    message: "boot build",
  };
  // What `bun run build:info` writes mid-process — a `bun run build`, a
  // `bun install`, or a sibling `bun run dev` all rewrite the generated module
  // while the dev server is up, and Next hot-reloads it.
  const regenerated = {
    sha: "abc1234",
    buildTime: "2026-08-21T18:01:06.523Z",
    message: "boot build",
  };

  it("keeps the identity a process booted with when the module is regenerated", () => {
    const pin: BuildIdentityPin = {};

    expect(pinBuildIdentity(pin, booted)).toEqual(booted);
    expect(pinBuildIdentity(pin, regenerated)).toEqual(booted);
  });

  it("reads the current module in a process that has not pinned yet", () => {
    expect(pinBuildIdentity({}, regenerated)).toEqual(regenerated);
  });
});

describe("buildInfoSchema", () => {
  it("rejects empty fields", () => {
    expect(
      buildInfoSchema.safeParse({ sha: "", buildTime: "", message: "" })
        .success,
    ).toBe(false);
    expect(
      buildInfoSchema.safeParse({
        sha: "abc",
        buildTime: "now",
        message: "init",
      }).success,
    ).toBe(true);
  });

  it("requires the commit message", () => {
    expect(
      buildInfoSchema.safeParse({ sha: "abc", buildTime: "now" }).success,
    ).toBe(false);
  });
});
