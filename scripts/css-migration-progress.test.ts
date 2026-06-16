import { describe, expect, it } from "vitest";

import {
  countTrackedSelectors,
  evaluateRatchet,
  OWNER_FLOORS,
  validateFloorCatalog,
  type OwnerEvalInput,
} from "./css-migration-progress";

/**
 * The migration unit is "selectors+keyframes per owner". These pin the exact
 * definition so the ratchet's count cannot silently change meaning.
 */
describe("countTrackedSelectors", () => {
  it("counts one per style rule and excludes non-selector at-rules", () => {
    const css = `
      @import "tailwindcss";
      @theme { --color-x: #fff; }
      @font-face { font-family: X; src: url(x.woff2); }
      .a { color: red; }
      .b { color: red; }
    `;
    expect(countTrackedSelectors(css)).toBe(2);
  });

  it("counts each member of a comma-separated selector list", () => {
    expect(countTrackedSelectors(".a, .b, .c { color: red; }")).toBe(3);
  });

  it("counts a @keyframes definition once and excludes its step rules", () => {
    const css = `@keyframes spin { 0% { opacity: 0; } 50% { opacity: .5; } 100% { opacity: 1; } }`;
    expect(countTrackedSelectors(css)).toBe(1);
  });

  it("counts style rules nested inside @media", () => {
    const css = `@media (max-width: 768px) { .a { color: red; } .b { color: red; } }`;
    expect(countTrackedSelectors(css)).toBe(2);
  });

  it("returns 0 for comment-only / empty CSS", () => {
    expect(countTrackedSelectors("/* placeholder */")).toBe(0);
  });
});

/**
 * Seeded-fixture ratchet test (task 6.1 / R8.2): all three cases driven through
 * the REAL pipeline — `countTrackedSelectors` on seeded CSS, then `evaluateRatchet`
 * — so the test exercises production logic, not a re-statement of it.
 */
describe("ratchet on a seeded CSS fixture", () => {
  const OWNER = "src/features/_fixture/fixture.css";

  // 7 tracked selectors: a(1) + b(1) + (c,d)(2) + scrollbar(1) + @keyframes(1)
  //                      + the @media child(1). @import / @theme do not count.
  const baselineCss = `
    @import "tailwindcss";
    @theme { --color-x: #fff; }
    .authored-a { color: red; }
    .authored-b { color: red; }
    .authored-c, .authored-d { color: red; }
    .panel::-webkit-scrollbar { width: 4px; }
    @keyframes spin { from { opacity: 0; } to { opacity: 1; } }
    @media (max-width: 768px) { .authored-e { color: red; } }
  `;
  const BASELINE = 7;
  // Floor = the 2 preserved-forever rules (the scrollbar + the keyframes).
  const FLOOR = 2;

  // Pin the fixture's baseline so the three mutations are unambiguous.
  it("the baseline fixture counts exactly the expected selectors", () => {
    expect(countTrackedSelectors(baselineCss)).toBe(BASELINE);
  });

  const evalOwner = (liveCount: number): ReturnType<typeof evaluateRatchet> =>
    evaluateRatchet([
      {
        path: OWNER,
        liveCount,
        baselineCount: BASELINE,
        floor: FLOOR,
        inCatalog: true,
      },
    ]);

  it("FAILS when an owner's count increases above its baseline", () => {
    const increasedCss = baselineCss + `\n.authored-f { color: red; }`;
    const live = countTrackedSelectors(increasedCss);
    expect(live).toBe(BASELINE + 1);

    const result = evalOwner(live);
    expect(result.ok).toBe(false);
    expect(result.statuses[0]?.state).toBe("increase");
    expect(result.statuses[0]?.violation).toBe(true);
  });

  it("FAILS when an owner's count drops below its declared floor", () => {
    // Deleting the preserved scrollbar + keyframes (and most authored rules)
    // takes the count under the floor — a preserved-forever rule was removed.
    const belowFloorCss = `.authored-a { color: red; }`;
    const live = countTrackedSelectors(belowFloorCss);
    expect(live).toBeLessThan(FLOOR);

    const result = evalOwner(live);
    expect(result.ok).toBe(false);
    expect(result.statuses[0]?.state).toBe("below-floor");
    expect(result.statuses[0]?.violation).toBe(true);
  });

  it("PASSES on a valid decrease that stays at or above the floor", () => {
    // Migrate two authored leaves away; preserved scrollbar + keyframes remain.
    const decreasedCss = `
      .authored-a { color: red; }
      .panel::-webkit-scrollbar { width: 4px; }
      @keyframes spin { from { opacity: 0; } to { opacity: 1; } }
      @media (max-width: 768px) { .authored-e { color: red; } }
    `;
    const live = countTrackedSelectors(decreasedCss);
    expect(live).toBeGreaterThanOrEqual(FLOOR);
    expect(live).toBeLessThan(BASELINE);

    const result = evalOwner(live);
    expect(result.ok).toBe(true);
    expect(result.statuses[0]?.state).toBe("decreased");
    expect(result.statuses[0]?.violation).toBe(false);
  });
});

describe("evaluateRatchet edge cases", () => {
  const base = (over: Partial<OwnerEvalInput>): OwnerEvalInput => ({
    path: "src/x.css",
    liveCount: 5,
    baselineCount: 5,
    floor: 0,
    inCatalog: true,
    ...over,
  });

  it("flags a CSS owner that is on disk but absent from the catalog", () => {
    const result = evaluateRatchet([base({ inCatalog: false })]);
    expect(result.ok).toBe(false);
    expect(result.statuses[0]?.state).toBe("untracked");
  });

  it("treats an owner with no baseline yet as a passing 'new' owner", () => {
    const result = evaluateRatchet([base({ baselineCount: null })]);
    expect(result.ok).toBe(true);
    expect(result.statuses[0]?.state).toBe("new");
  });

  it("an unchanged owner at its baseline is ok", () => {
    const result = evaluateRatchet([base({ liveCount: 5, baselineCount: 5 })]);
    expect(result.ok).toBe(true);
    expect(result.statuses[0]?.state).toBe("ok");
  });

  it("a single violating owner fails the whole run", () => {
    const result = evaluateRatchet([
      base({ path: "src/a.css", liveCount: 5, baselineCount: 5 }),
      base({ path: "src/b.css", liveCount: 9, baselineCount: 5 }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.statuses.filter((s) => s.violation)).toHaveLength(1);
  });
});

describe("validateFloorCatalog", () => {
  it("the shipped OWNER_FLOORS catalog is internally consistent", () => {
    expect(validateFloorCatalog(OWNER_FLOORS)).toEqual([]);
  });

  it("every preserved owner declares a non-zero floor", () => {
    const preserved = OWNER_FLOORS.filter((o) => o.preserved);
    expect(preserved.length).toBeGreaterThan(0);
    for (const owner of preserved) expect(owner.floor).toBeGreaterThan(0);
  });

  it("flags a preserved owner with a zero floor", () => {
    const issues = validateFloorCatalog([
      { path: "src/x.css", preserved: true, floor: 0, note: "" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("must be > 0");
  });

  it("flags a non-preserved owner with a non-zero floor", () => {
    const issues = validateFloorCatalog([
      { path: "src/y.css", preserved: false, floor: 4, note: "" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("must be 0");
  });

  it("flags a duplicate catalog entry", () => {
    const issues = validateFloorCatalog([
      { path: "src/dup.css", preserved: false, floor: 0, note: "" },
      { path: "src/dup.css", preserved: false, floor: 0, note: "" },
    ]);
    expect(issues.some((i) => i.includes("duplicate"))).toBe(true);
  });
});
