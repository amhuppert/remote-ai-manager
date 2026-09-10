// @vitest-inputs src/**/*.css
/**
 * Theme-surface namespace contract (Tailwind migration tasks 2.2–2.5;
 * requirements 2.1, 2.4, 2.5, 5.1).
 *
 * The CC design-token surface is bridged onto Tailwind v4 in
 * `src/features/_root/styles/theme.css`. This test pins that surface as a
 * contract: every token across all token families is registered under its
 * CORRECT Tailwind namespace, and the extract-lane invariants (z-index tier
 * ordering, frozen desktop-first breakpoints, tokenized animations resolving to
 * real keyframes) hold. It fails if a token is dropped, mis-namespaced, or the
 * stacking order regresses.
 *
 * This is a TOKEN-SURFACE assertion, not a CSS-structure one: it asserts what
 * the theme exposes and the guarantees that ride on it — never "selector X
 * exists" or a rendered className string.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const THEME_PATH = path.resolve(
  __dirname,
  "../../features/_root/styles/theme.css",
);
const SRC_DIR = path.resolve(__dirname, "../..");

/** Custom-property declarations across every `@theme` / `@theme inline` block. */
function themeTokens(): Map<string, string> {
  const root = postcss.parse(readFileSync(THEME_PATH, "utf8"));
  const tokens = new Map<string, string>();
  root.walkAtRules("theme", (at) => {
    at.walkDecls((decl) => {
      if (decl.prop.startsWith("--")) tokens.set(decl.prop, decl.value.trim());
    });
  });
  return tokens;
}

/** `@custom-variant <name> (<at-rule>)` → Map<name, params-after-name>. */
function customVariants(): Map<string, string> {
  const root = postcss.parse(readFileSync(THEME_PATH, "utf8"));
  const variants = new Map<string, string>();
  root.walkAtRules("custom-variant", (at) => {
    const name = at.params.split(/\s+/)[0] ?? "";
    variants.set(name, at.params.slice(name.length).trim());
  });
  return variants;
}

/** Concatenated text of every CC stylesheet (for keyframe-existence checks). */
function allCss(): string {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".css"))
    .map((rel) => path.join(SRC_DIR, rel));
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

// Expected token manifest, grouped by the namespace each family must register
// under. Order within a list is irrelevant except for the z-index tier scale,
// which has its own ordering test below.
const EXPECTED: Record<string, string[]> = {
  // Alias lane — colors (text colors live HERE, under --color-text-*, never --text-*)
  "--color-": [
    "bg-void",
    "bg-base",
    "bg-surface",
    "bg-raised",
    "bg-elevated",
    "bg-hover",
    "border-dim",
    "border-subtle",
    "border-default",
    "border-strong",
    "cyan",
    "cyan-dim",
    "cyan-glow",
    "cyan-glow-strong",
    "cyan-glow-text",
    "amber",
    "amber-dim",
    "amber-glow",
    "green",
    "green-dim",
    "green-glow",
    "blue",
    "blue-dim",
    "blue-glow",
    "red",
    "red-dim",
    "red-glow",
    "red-text",
    "violet",
    "violet-dim",
    "violet-glow",
    "violet-glow-strong",
    "rainbow-glow",
    "rainbow-glow-strong",
    "rainbow-glow-blue",
    "text-primary",
    "text-secondary",
    "text-tertiary",
    "text-inverse",
  ],
  // Alias lane — background images (rainbow gradients; a gradient is not a color)
  "--background-image-": ["rainbow", "rainbow-tint"],
  // Alias lane — spacing
  "--spacing-": [
    "2xs",
    "xs",
    "sm",
    "md",
    "lg",
    "xl",
    "2xl",
    "3xl",
    "section",
    "header-content",
    "item",
  ],
  // Alias lane — radii
  "--radius-": ["sm", "md", "lg"],
  // Alias lane — font families
  "--font-": ["display", "body", "mono"],
  // Alias lane — sizing floors (deliberate non-font-size namespace)
  "--cc-size-floor-": ["font", "icon", "icon-btn", "touch"],
  // Extract lane — z-index tiers (ordering asserted separately)
  "--z-index-": [
    "base",
    "raised",
    "sticky",
    "header",
    "panel",
    "nav",
    "dropdown",
    "toast",
    "menu",
    "popover",
    "overlay",
    "tooltip",
  ],
  // Extract lane — breakpoints (frozen set)
  "--breakpoint-": [
    "640",
    "768",
    "769",
    "800",
    "900",
    "960",
    "1080",
    "1100",
    "1180",
  ],
  // Extract lane — animations
  "--animate-": ["pulse-dot", "fade-in", "bulk-float-in"],
};

// Ordered low→high, mapped to CC's actual stacking bands; this is the contract
// the stacking guarantee rides on. Toasts (dropdown/toast tiers) sit BELOW the
// menu/popover cluster, which sits below overlays and tooltips — matching the
// legacy literals (cc-toast 200 / merge-toast 300 < menus 1000 < peek 1100 <
// overlays 9998/9999 < tooltips 99999).
const Z_TIER_ORDER = [
  "base",
  "raised",
  "sticky",
  "header",
  "panel",
  "nav",
  "dropdown",
  "toast",
  "menu",
  "popover",
  "overlay",
  "tooltip",
];

describe("theme surface — namespace contract (all token families)", () => {
  const tokens = themeTokens();

  for (const [ns, names] of Object.entries(EXPECTED)) {
    for (const name of names) {
      it(`registers ${ns}${name} under the ${ns}* namespace`, () => {
        expect(
          tokens.has(`${ns}${name}`),
          `missing or mis-namespaced token: expected ${ns}${name} on the @theme surface`,
        ).toBe(true);
      });
    }
  }

  it("registers NO text color under the --text-* (font-size) namespace", () => {
    // Tailwind v4 reads --text-* as a font-size scale. CC's text COLORS must be
    // --color-text-*; sizing floors must use --cc-size-floor-*. A stray --text-*
    // token would generate font-size utilities for a color/floor — a silent bug.
    const misnamed = [...themeTokens().keys()].filter((p) =>
      /^--text-/.test(p),
    );
    expect(
      misnamed,
      `--text-* tokens must not exist: ${misnamed.join(", ")}`,
    ).toEqual([]);
  });
});

describe("theme surface — z-index tier scale (ordering guarantee)", () => {
  const tokens = themeTokens();

  it("exposes every tier and they strictly increase in stacking order", () => {
    const values = Z_TIER_ORDER.map((tier) => {
      const raw = tokens.get(`--z-index-${tier}`);
      expect(raw, `missing z-index tier --z-index-${tier}`).toBeDefined();
      return Number(raw);
    });
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i]! > values[i - 1]!,
        `z-index tiers out of order: ${Z_TIER_ORDER[i - 1]}(${values[i - 1]}) must be < ${Z_TIER_ORDER[i]}(${values[i]})`,
      ).toBe(true);
    }
  });

  it("re-homes the dropdown-above-panels-below-tooltips guarantee onto the tiers", () => {
    // The ordering the ModelSelector test used to assert against raw globals.css
    // is now a property of the tier tokens: a portaled dropdown stacks above the
    // side/unified panels but below tooltips.
    const panel = Number(tokens.get("--z-index-panel"));
    const dropdown = Number(tokens.get("--z-index-dropdown"));
    const tooltip = Number(tokens.get("--z-index-tooltip"));
    expect(dropdown).toBeGreaterThan(panel);
    expect(dropdown).toBeLessThan(tooltip);
  });
});

describe("theme surface — breakpoints (frozen, desktop-first)", () => {
  const variants = customVariants();

  it("registers desktop-first max-* variants over @media (max-width: …) — not inverted to mobile-first", () => {
    for (const px of [
      "640",
      "768",
      "800",
      "900",
      "960",
      "1080",
      "1100",
      "1180",
    ]) {
      const params = variants.get(`max-${px}`);
      expect(params, `missing @custom-variant max-${px}`).toBeDefined();
      expect(params).toContain(`max-width: ${px}px`);
    }
  });

  it("keeps the 769px min-width companion for the existing mobile-first rules", () => {
    const params = variants.get("min-769");
    expect(params, "missing @custom-variant min-769").toBeDefined();
    expect(params).toContain("min-width: 769px");
  });

  it("the breakpoint token values match their pixel thresholds", () => {
    const tokens = themeTokens();
    for (const px of [
      "640",
      "768",
      "769",
      "800",
      "900",
      "960",
      "1080",
      "1100",
      "1180",
    ]) {
      expect(tokens.get(`--breakpoint-${px}`)).toBe(`${px}px`);
    }
  });
});

describe("theme surface — animations resolve to real keyframes", () => {
  const tokens = themeTokens();
  const css = allCss();

  for (const name of EXPECTED["--animate-"]!) {
    it(`--animate-${name} references a defined @keyframes`, () => {
      const value = tokens.get(`--animate-${name}`);
      expect(value, `missing --animate-${name}`).toBeDefined();
      const keyframe = value!.split(/\s+/)[0]!;
      expect(
        new RegExp(`@keyframes\\s+${keyframe}\\b`).test(css),
        `--animate-${name} points at @keyframes ${keyframe}, which is not defined in any stylesheet`,
      ).toBe(true);
    });
  }
});
