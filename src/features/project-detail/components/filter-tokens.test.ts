import { describe, it, expect } from "vitest";
import {
  tokensToSearchParams,
  searchParamsToTokens,
  type FilterState,
  type FilterToken,
} from "./filter-tokens";

function roundTrip(state: FilterState): FilterState {
  return searchParamsToTokens(tokensToSearchParams(state));
}

describe("tokensToSearchParams", () => {
  it("emits no params for an empty state", () => {
    const params = tokensToSearchParams({ tokens: [], draft: "" });
    expect(params.toString()).toBe("");
  });

  it("emits archived=include for non-exclusive archived token", () => {
    const tokens: FilterToken[] = [
      { cat: "archived", key: "include", value: "include" },
    ];
    const params = tokensToSearchParams({ tokens, draft: "" });
    expect(params.get("archived")).toBe("include");
  });

  it("emits archived=only for exclusive archived token", () => {
    const tokens: FilterToken[] = [
      { cat: "archived", key: "only", value: "only", exclusive: true },
    ];
    const params = tokensToSearchParams({ tokens, draft: "" });
    expect(params.get("archived")).toBe("only");
  });

  it("emits status / target / branch values", () => {
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
      { cat: "target", key: "target", value: "main" },
      { cat: "branch", key: "branch", value: "csm/foo" },
    ];
    const params = tokensToSearchParams({ tokens, draft: "" });
    expect(params.get("status")).toBe("running");
    expect(params.get("target")).toBe("main");
    expect(params.get("branch")).toBe("csm/foo");
  });

  it("emits q for non-empty draft", () => {
    const params = tokensToSearchParams({ tokens: [], draft: "hello" });
    expect(params.get("q")).toBe("hello");
  });

  it("omits q for empty draft", () => {
    const params = tokensToSearchParams({ tokens: [], draft: "" });
    expect(params.has("q")).toBe(false);
  });
});

describe("searchParamsToTokens", () => {
  it("parses archived=include", () => {
    const state = searchParamsToTokens(new URLSearchParams("archived=include"));
    expect(state.tokens).toEqual([
      { cat: "archived", key: "include", value: "include" },
    ]);
    expect(state.draft).toBe("");
  });

  it("parses archived=only as exclusive", () => {
    const state = searchParamsToTokens(new URLSearchParams("archived=only"));
    expect(state.tokens).toEqual([
      { cat: "archived", key: "only", value: "only", exclusive: true },
    ]);
  });

  it("parses status/target/branch/q", () => {
    const state = searchParamsToTokens(
      new URLSearchParams(
        "status=awaiting&target=develop&branch=csm/bar&q=needle",
      ),
    );
    expect(state.tokens).toEqual(
      expect.arrayContaining([
        { cat: "status", key: "is", value: "awaiting" },
        { cat: "target", key: "target", value: "develop" },
        { cat: "branch", key: "branch", value: "csm/bar" },
      ]),
    );
    expect(state.tokens).toHaveLength(3);
    expect(state.draft).toBe("needle");
  });

  it("ignores unknown keys", () => {
    const state = searchParamsToTokens(
      new URLSearchParams("foo=bar&status=running"),
    );
    expect(state.tokens).toEqual([
      { cat: "status", key: "is", value: "running" },
    ]);
  });

  it("ignores invalid archived value", () => {
    const state = searchParamsToTokens(new URLSearchParams("archived=garbage"));
    expect(state.tokens).toEqual([]);
  });
});

describe("filter-tokens round-trip", () => {
  it.each<FilterState>([
    { tokens: [], draft: "" },
    { tokens: [], draft: "search me" },
    {
      tokens: [{ cat: "archived", key: "include", value: "include" }],
      draft: "",
    },
    {
      tokens: [
        { cat: "archived", key: "only", value: "only", exclusive: true },
      ],
      draft: "",
    },
    {
      tokens: [
        { cat: "status", key: "is", value: "running" },
        { cat: "target", key: "target", value: "main" },
      ],
      draft: "foo",
    },
    {
      tokens: [{ cat: "branch", key: "branch", value: "csm/example" }],
      draft: "",
    },
  ])("round-trips %s", (state) => {
    const result = roundTrip(state);
    expect(result.draft).toBe(state.draft);
    expect(new Set(result.tokens)).toEqual(new Set(state.tokens));
  });
});
