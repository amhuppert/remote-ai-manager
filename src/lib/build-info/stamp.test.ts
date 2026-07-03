import { describe, expect, it } from "vitest";
import {
  buildInfoSchema,
  formatBuildStamp,
  renderBuildInfoModule,
} from "./stamp";

describe("formatBuildStamp", () => {
  it("joins sha and build time into a single stamp", () => {
    expect(
      formatBuildStamp({
        sha: "abc1234",
        buildTime: "2026-07-02T10:00:00.000Z",
      }),
    ).toBe("abc1234-2026-07-02T10:00:00.000Z");
  });
});

describe("renderBuildInfoModule", () => {
  it("renders a TS module whose BUILD_INFO round-trips the input", () => {
    const info = { sha: "abc1234", buildTime: "2026-07-02T10:00:00.000Z" };
    const source = renderBuildInfoModule(info);

    expect(source).toContain("export const BUILD_INFO");
    expect(source).toContain('"abc1234"');
    expect(source).toContain('"2026-07-02T10:00:00.000Z"');
    expect(source).toContain("do not edit");
  });

  it("escapes values so arbitrary strings cannot break the module source", () => {
    const source = renderBuildInfoModule({
      sha: 'x"; process.exit(1); //',
      buildTime: "t",
    });
    expect(source).toContain(String.raw`"x\"; process.exit(1); //"`);
  });
});

describe("buildInfoSchema", () => {
  it("rejects empty fields", () => {
    expect(buildInfoSchema.safeParse({ sha: "", buildTime: "" }).success).toBe(
      false,
    );
    expect(
      buildInfoSchema.safeParse({ sha: "abc", buildTime: "now" }).success,
    ).toBe(true);
  });
});
