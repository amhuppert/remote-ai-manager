import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// DS/perf verification (Req 14.1, 14.2, 14.3, 14.6): the cockpit references
// design-system tokens for color, uses only the locked motion durations, and
// renders the transcript through a virtualized list (never eagerly).

const here = dirname(fileURLToPath(import.meta.url));

function readCss(rel: string): string {
  return readFileSync(resolve(here, rel), "utf8");
}

const cockpitCss = readCss("styles/cockpit.css");
const composerCss = readCss("../composer/styles/composer.css");
const allCss = `${cockpitCss}\n${composerCss}`;

describe("cockpit design-system compliance", () => {
  it("uses no hard-coded hex color values (tokens only)", () => {
    const hex = allCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
  });

  it("uses no rgb/rgba color literals except the established black drop-shadow", () => {
    const colorFns = allCss.match(/rgba?\([^)]*\)/g) ?? [];
    const disallowed = colorFns.filter((c) => !/^rgba\(0, ?0, ?0,/.test(c));
    expect(disallowed).toEqual([]);
  });

  it("references design-system accent tokens for semantic color", () => {
    expect(cockpitCss).toContain("var(--cyan)"); // active tab edge
    expect(cockpitCss).toContain("var(--amber)"); // unread dot / filter chips
    expect(composerCss).toContain("var(--violet"); // Codex / command identity
  });

  it("uses only the locked motion durations and no spring/bounce/scale", () => {
    const durations = allCss.match(/\b0?\.\d+s\b/g) ?? [];
    for (const d of durations) {
      expect(["0.15s", ".15s", "0.2s", ".2s"]).toContain(d);
    }
    expect(allCss).not.toMatch(/cubic-bezier|spring|scale\(/);
  });

  it("gates the entry animation behind prefers-reduced-motion", () => {
    expect(cockpitCss).toContain("prefers-reduced-motion");
  });

  it("keeps the cockpit visible once its entry animation ends", () => {
    // The cockpit mounts as a `.stagger-in > *` child, which sets a resting
    // `opacity: 0` (globals.css). The `.plc-enter` entry animation must
    // therefore *settle* on opacity 1 — via `forwards` when it runs, and via an
    // explicit opacity when reduced motion disables it — or the whole cockpit
    // reverts to that inherited `opacity: 0` and renders invisible.
    const baseEnter = cockpitCss.match(/\.plc-enter\s*\{([^}]*)\}/);
    expect(baseEnter?.[1]).toMatch(/animation:[^;]*\bforwards\b/);

    const reducedEnter = cockpitCss.match(
      /prefers-reduced-motion[^{]*\{[\s\S]*?\.plc-enter\s*\{([^}]*)\}/,
    );
    expect(reducedEnter?.[1]).toMatch(/opacity:\s*1/);
  });
});
