/**
 * Design-system accessibility & legibility guarantees, re-homed onto the
 * Tailwind `@theme` token surface (Tailwind migration task 3.1; requirements
 * 2.4, 5.1, 5.2, 5.3).
 *
 * These are the GENUINE guarantees previously checked by reading raw CSS in
 * `design-system-compliance.test.ts` (now deleted): WCAG text-contrast
 * thresholds and the minimum sizing floors. They are re-homed here to assert
 * against the `@theme` surface — each guarantee enters through a `@theme` token
 * (`--color-text-*`, `--color-bg-*`, `--cc-size-floor-*`) and resolves through
 * the alias bridge to its concrete value. So the guarantee fails if a token is
 * dropped, re-aliased to a weaker value, or the underlying legacy value is
 * weakened below threshold. This is NOT a CSS-structure assertion — it never
 * checks a selector or a className.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { describe, expect, test } from "vitest";

const THEME_PATH = path.resolve(
  __dirname,
  "../../features/_root/styles/theme.css",
);
const TOKENS_PATH = path.resolve(
  __dirname,
  "../../features/_root/styles/tokens.css",
);

/**
 * Every custom property declared on the bridged token surface and its legacy
 * source: the `@theme` aliases (theme.css) plus the legacy `:root` values
 * (tokens.css) they resolve to.
 */
function tokenMap(): Map<string, string> {
  const map = new Map<string, string>();
  const themeRoot = postcss.parse(readFileSync(THEME_PATH, "utf8"));
  themeRoot.walkAtRules("theme", (at) => {
    at.walkDecls((d) => {
      if (d.prop.startsWith("--")) map.set(d.prop, d.value.trim());
    });
  });
  const tokensRoot = postcss.parse(readFileSync(TOKENS_PATH, "utf8"));
  tokensRoot.walkRules((rule) => {
    if (rule.selector !== ":root") return;
    rule.walkDecls((d) => {
      if (d.prop.startsWith("--") && !map.has(d.prop))
        map.set(d.prop, d.value.trim());
    });
  });
  return map;
}

const TOKENS = tokenMap();

/** Resolve a custom property through `var()` aliases to its concrete value. */
function resolve(prop: string, seen = new Set<string>()): string {
  if (seen.has(prop)) throw new Error(`circular token reference at ${prop}`);
  seen.add(prop);
  const value = TOKENS.get(prop);
  if (value == null) throw new Error(`token ${prop} is not on the surface`);
  const varMatch = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
  return varMatch ? resolve(varMatch[1]!, seen) : value;
}

/** Resolve a `@theme` color token (e.g. "text-tertiary") to a 6-digit hex. */
function themeColor(name: string): string {
  const hex = resolve(`--color-${name}`);
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`--color-${name} did not resolve to a hex color: ${hex}`);
  }
  return hex;
}

// --- WCAG contrast (sRGB → relative luminance → ratio) ---

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linearize = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two `@theme` color tokens. */
function contrast(colorName: string, bgName: string): number {
  const l1 = relativeLuminance(hexToRgb(themeColor(colorName)));
  const l2 = relativeLuminance(hexToRgb(themeColor(bgName)));
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Resolve a `--cc-size-floor-*` token to a numeric value in its unit. */
function sizeFloor(name: string): { value: number; unit: string } {
  const raw = resolve(`--cc-size-floor-${name}`);
  const m = raw.match(/^([\d.]+)(px|rem)$/);
  if (!m)
    throw new Error(`--cc-size-floor-${name} is not a px/rem length: ${raw}`);
  return { value: parseFloat(m[1]!), unit: m[2]! };
}

describe("WCAG text-contrast guarantees (re-homed to the @theme surface)", () => {
  // The text/background colors enter through the `--color-text-*` / `--color-bg-*`
  // theme tokens and resolve through the alias bridge to their hex values.
  test("text-tertiary ≥ 4.5:1 against bg-void", () => {
    expect(contrast("text-tertiary", "bg-void")).toBeGreaterThanOrEqual(4.5);
  });

  test("text-tertiary ≥ 4.5:1 against bg-surface", () => {
    expect(contrast("text-tertiary", "bg-surface")).toBeGreaterThanOrEqual(4.5);
  });

  test("text-tertiary ≥ 3:1 against bg-raised", () => {
    expect(contrast("text-tertiary", "bg-raised")).toBeGreaterThanOrEqual(3.0);
  });

  test("text-secondary ≥ 4.5:1 against bg-void", () => {
    expect(contrast("text-secondary", "bg-void")).toBeGreaterThanOrEqual(4.5);
  });

  test("red-text ≥ 4.5:1 against bg-surface", () => {
    expect(contrast("red-text", "bg-surface")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Legibility & target-size floors (re-homed to the @theme surface)", () => {
  // Asserted against the deliberate `--cc-size-floor-*` namespace, not raw CSS
  // and not the font-size scale. A token weakened below its floor fails.
  test("font-size floor is at least 0.7rem", () => {
    const floor = sizeFloor("font");
    expect(floor.unit).toBe("rem");
    expect(floor.value).toBeGreaterThanOrEqual(0.7);
  });

  test("minimum icon size is at least 20px", () => {
    const floor = sizeFloor("icon");
    expect(floor.unit).toBe("px");
    expect(floor.value).toBeGreaterThanOrEqual(20);
  });

  test("minimum icon-button size is at least 24px", () => {
    const floor = sizeFloor("icon-btn");
    expect(floor.unit).toBe("px");
    expect(floor.value).toBeGreaterThanOrEqual(24);
  });

  test("minimum touch target is at least 44px (WCAG 2.5.5)", () => {
    const floor = sizeFloor("touch");
    expect(floor.unit).toBe("px");
    expect(floor.value).toBeGreaterThanOrEqual(44);
  });
});
