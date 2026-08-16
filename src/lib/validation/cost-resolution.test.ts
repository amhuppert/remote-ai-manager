import { describe, expect, it } from "vitest";
import { maxDeclaredCost, resolveSubmissionCost } from "./cost-resolution";

describe("resolveSubmissionCost", () => {
  const table = {
    full: 8,
    changed: 4,
    paths: { base: 1, perPath: 1 },
  } as const;

  it.each([
    { effectiveScope: "full" as const, scopedPathCount: 0 },
    { effectiveScope: "changed" as const, scopedPathCount: 0 },
    { effectiveScope: "changed" as const, scopedPathCount: 3 },
  ])(
    "passes a scalar cost through for $effectiveScope with $scopedPathCount paths",
    ({ effectiveScope, scopedPathCount }) => {
      expect(
        resolveSubmissionCost({ cost: 6, effectiveScope, scopedPathCount }),
      ).toBe(6);
    },
  );

  it("charges the full weight for a full run", () => {
    expect(
      resolveSubmissionCost({
        cost: table,
        effectiveScope: "full",
        scopedPathCount: 0,
      }),
    ).toBe(8);
  });

  it("charges the declared changed weight for a pathless changed run", () => {
    expect(
      resolveSubmissionCost({
        cost: table,
        effectiveScope: "changed",
        scopedPathCount: 0,
      }),
    ).toBe(4);
  });

  it("falls back to full for a pathless changed run with no declared changed weight", () => {
    expect(
      resolveSubmissionCost({
        cost: { full: 8 },
        effectiveScope: "changed",
        scopedPathCount: 0,
      }),
    ).toBe(8);
  });

  it.each([
    { scopedPathCount: 1, expected: 2 },
    { scopedPathCount: 3, expected: 4 },
  ])(
    "charges base + perPath * $scopedPathCount for a scoped run",
    ({ scopedPathCount, expected }) => {
      expect(
        resolveSubmissionCost({
          cost: table,
          effectiveScope: "changed",
          scopedPathCount,
        }),
      ).toBe(expected);
    },
  );

  it("caps a large scoped run at the changed weight", () => {
    expect(
      resolveSubmissionCost({
        cost: table,
        effectiveScope: "changed",
        scopedPathCount: 40,
      }),
    ).toBe(4);
  });

  it("caps a large scoped run at full when changed is undeclared", () => {
    expect(
      resolveSubmissionCost({
        cost: { full: 8, paths: { base: 2, perPath: 1 } },
        effectiveScope: "changed",
        scopedPathCount: 40,
      }),
    ).toBe(8);
  });

  it("charges a flat weight for every scoped run when perPath is zero", () => {
    const flat = { full: 8, changed: 4, paths: { base: 2, perPath: 0 } };

    expect(
      resolveSubmissionCost({
        cost: flat,
        effectiveScope: "changed",
        scopedPathCount: 1,
      }),
    ).toBe(2);
    expect(
      resolveSubmissionCost({
        cost: flat,
        effectiveScope: "changed",
        scopedPathCount: 40,
      }),
    ).toBe(2);
  });

  it("charges the changed weight for a scoped run with no paths block", () => {
    expect(
      resolveSubmissionCost({
        cost: { full: 8, changed: 4 },
        effectiveScope: "changed",
        scopedPathCount: 3,
      }),
    ).toBe(4);
  });

  it("charges full for a scoped run with neither a paths block nor a changed weight", () => {
    expect(
      resolveSubmissionCost({
        cost: { full: 8 },
        effectiveScope: "changed",
        scopedPathCount: 3,
      }),
    ).toBe(8);
  });
});

describe("maxDeclaredCost", () => {
  it("passes a scalar declaration through", () => {
    expect(maxDeclaredCost(7)).toBe(7);
  });

  it("quotes the full weight for a table, ignoring its cheaper scopes", () => {
    expect(
      maxDeclaredCost({ full: 8, changed: 4, paths: { base: 1, perPath: 1 } }),
    ).toBe(8);
  });
});
