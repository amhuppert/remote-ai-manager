import { describe, it, expect } from "vitest";
import { parseFilterDraft, replaceTokenByCat } from "./parse-filter-draft";
import type { FilterToken } from "../components/filter-tokens";

describe("parseFilterDraft", () => {
  it("parses is:<status> into a status token keyed 'is'", () => {
    expect(parseFilterDraft("is:running")).toEqual({
      cat: "status",
      key: "is",
      value: "running",
    });
  });

  it("aliases status: to the is-keyed status token", () => {
    expect(parseFilterDraft("status:awaiting")).toEqual({
      cat: "status",
      key: "is",
      value: "awaiting",
    });
  });

  it("parses target: and branch:", () => {
    expect(parseFilterDraft("target:main")).toEqual({
      cat: "target",
      key: "target",
      value: "main",
    });
    expect(parseFilterDraft("branch:feature/x")).toEqual({
      cat: "branch",
      key: "branch",
      value: "feature/x",
    });
  });

  it("maps archived:true and archived:include to the include token", () => {
    const include = { cat: "archived", key: "include", value: "include" };
    expect(parseFilterDraft("archived:true")).toEqual(include);
    expect(parseFilterDraft("archived:include")).toEqual(include);
  });

  it("maps archived:only to the exclusive only-archived token", () => {
    expect(parseFilterDraft("archived:only")).toEqual({
      cat: "archived",
      key: "only",
      value: "only",
      exclusive: true,
    });
  });

  it("returns null for an unrecognized key, a missing value, or no colon", () => {
    expect(parseFilterDraft("nope:value")).toBeNull();
    expect(parseFilterDraft("is:")).toBeNull();
    expect(parseFilterDraft("just prose")).toBeNull();
    expect(parseFilterDraft(":value")).toBeNull();
  });

  it("is case-insensitive on the key and trims", () => {
    expect(parseFilterDraft("  IS:running ")).toEqual({
      cat: "status",
      key: "is",
      value: "running",
    });
  });
});

describe("replaceTokenByCat", () => {
  it("replaces an existing token of the same category", () => {
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
      { cat: "target", key: "target", value: "main" },
    ];
    const next = replaceTokenByCat(tokens, {
      cat: "status",
      key: "is",
      value: "awaiting",
    });
    expect(next).toEqual([
      { cat: "target", key: "target", value: "main" },
      { cat: "status", key: "is", value: "awaiting" },
    ]);
  });

  it("appends when no token of that category exists", () => {
    const next = replaceTokenByCat([], {
      cat: "branch",
      key: "branch",
      value: "x",
    });
    expect(next).toEqual([{ cat: "branch", key: "branch", value: "x" }]);
  });
});
