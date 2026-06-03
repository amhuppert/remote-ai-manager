import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// DS compliance (Req 2.6): the spawn card references design-system tokens for
// color/spacing and uses only the locked motion durations — no hard-coded
// visual values.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "spawn-card.css"), "utf8");

describe("spawn-card design-system compliance", () => {
  it("uses no hard-coded hex color values (tokens only)", () => {
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
  });

  it("uses no rgb/rgba color literals except a black drop-shadow", () => {
    const colorFns = css.match(/rgba?\([^)]*\)/g) ?? [];
    const disallowed = colorFns.filter((c) => !/^rgba\(0, ?0, ?0,/.test(c));
    expect(disallowed).toEqual([]);
  });

  it("references design-system tokens for color and spacing", () => {
    expect(css).toContain("var(--cyan)");
    expect(css).toContain("var(--bg-surface)");
    expect(css).toContain("var(--space-");
    expect(css).toContain("var(--radius-lg)");
  });

  it("uses only the locked motion durations and no spring/bounce/scale", () => {
    const durations = css.match(/\b0?\.\d+s\b/g) ?? [];
    for (const d of durations) {
      expect(["0.15s", ".15s", "0.2s", ".2s"]).toContain(d);
    }
    expect(css).not.toMatch(/cubic-bezier|spring|scale\(/);
  });
});
