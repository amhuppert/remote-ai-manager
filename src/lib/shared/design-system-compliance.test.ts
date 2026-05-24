/**
 * Design System Compliance Tests
 *
 * Verifies CSS tokens, sizing floors, and canonical patterns in globals.css
 * meet the design system revamp specification requirements.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const GLOBALS_PATH = path.resolve(__dirname, "../../app/globals.css");
const ROOT_STYLES_DIR = path.resolve(__dirname, "../../features/_root/styles");
const ROOT_PARTIALS = [
  "tokens.css",
  "reset.css",
  "typography.css",
  "shell.css",
  "topbar.css",
  "sidebar-nav.css",
  "keyboard-shortcuts-modal.css",
];
const css = [
  ...ROOT_PARTIALS.map((p) =>
    readFileSync(path.join(ROOT_STYLES_DIR, p), "utf-8"),
  ),
  readFileSync(GLOBALS_PATH, "utf-8"),
].join("\n");

// --- WCAG Contrast Helpers ---

/** Parse hex color to sRGB [0..1] components */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Relative luminance per WCAG 2.1 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linearize = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two hex colors */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hexToRgb(hex1));
  const l2 = relativeLuminance(hexToRgb(hex2));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Extract a CSS custom property value from :root */
function getCssVar(varName: string): string | null {
  // Match within :root block
  const rootMatch = css.match(/:root\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
  if (!rootMatch?.[1]) return null;
  const rootBlock = rootMatch[1];
  const regex = new RegExp(`${varName.replace("--", "\\-\\-")}:\\s*([^;]+);`);
  const match = rootBlock.match(regex);
  return match?.[1]?.trim() ?? null;
}

/** Extract all font-size declarations with rem values */
function getAllFontSizeRem(): { line: number; value: number; rule: string }[] {
  const results: { line: number; value: number; rule: string }[] = [];
  const lines = css.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes("allow-small")) continue;
    const match = line.match(/font-size:\s*([\d.]+)rem/);
    if (match?.[1]) {
      results.push({
        line: i + 1,
        value: parseFloat(match[1]),
        rule: line.trim(),
      });
    }
  }
  return results;
}

// --- Test Suites ---

describe("Task 1.1: Text Contrast Tokens", () => {
  const BG_VOID = "#06090f";
  const BG_SURFACE = "#111825";
  const BG_RAISED = "#172033";

  test("--text-tertiary achieves >= 4.5:1 contrast against --bg-void", () => {
    const tertiary = getCssVar("--text-tertiary");
    expect(tertiary).not.toBeNull();
    const ratio = contrastRatio(tertiary!, BG_VOID);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("--text-tertiary achieves >= 4.5:1 contrast against --bg-surface", () => {
    const tertiary = getCssVar("--text-tertiary");
    expect(tertiary).not.toBeNull();
    const ratio = contrastRatio(tertiary!, BG_SURFACE);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("--text-tertiary achieves >= 3:1 contrast against --bg-raised", () => {
    const tertiary = getCssVar("--text-tertiary");
    expect(tertiary).not.toBeNull();
    const ratio = contrastRatio(tertiary!, BG_RAISED);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });

  test("--text-secondary achieves >= 4.5:1 contrast against --bg-void", () => {
    const secondary = getCssVar("--text-secondary");
    expect(secondary).not.toBeNull();
    const ratio = contrastRatio(secondary!, BG_VOID);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("--red-text token exists and achieves >= 4.5:1 against --bg-surface", () => {
    const redText = getCssVar("--red-text");
    expect(redText).not.toBeNull();
    const ratio = contrastRatio(redText!, BG_SURFACE);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("--red-dim is NOT used as text color (replaced by --red-text)", () => {
    // --red-dim should not appear as a color value (text usage)
    // It can still appear in border-color and background usages
    const textUsages = css
      .split("\n")
      .filter(
        (line) =>
          line.includes("color: var(--red-dim)") &&
          !/border(-(left|right|top|bottom))?-color/.test(line) &&
          !line.includes("background"),
      );
    expect(textUsages).toHaveLength(0);
  });
});

describe("Task 1.2: Sizing Floor and Spacing Tokens", () => {
  test("--font-size-floor token exists with value 0.7rem", () => {
    expect(getCssVar("--font-size-floor")).toBe("0.7rem");
  });

  test("--icon-size-min token exists with value 20px", () => {
    expect(getCssVar("--icon-size-min")).toBe("20px");
  });

  test("--icon-btn-min token exists with value 24px", () => {
    expect(getCssVar("--icon-btn-min")).toBe("24px");
  });

  test("--touch-target-min token exists with value 44px", () => {
    expect(getCssVar("--touch-target-min")).toBe("44px");
  });

  test("--space-section token exists", () => {
    expect(getCssVar("--space-section")).toBe("var(--space-xl)");
  });

  test("--space-header-content token exists", () => {
    expect(getCssVar("--space-header-content")).toBe("var(--space-sm)");
  });

  test("--space-item token exists", () => {
    expect(getCssVar("--space-item")).toBe("var(--space-xs)");
  });
});

describe("Task 2.1: Font Size Floor Enforcement", () => {
  test("no font-size declarations below 0.7rem", () => {
    const violations = getAllFontSizeRem().filter((f) => f.value < 0.7);
    if (violations.length > 0) {
      const details = violations
        .slice(0, 10)
        .map((v) => `  L${v.line}: ${v.value}rem — ${v.rule}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} font-size values below 0.7rem:\n${details}`,
      );
    }
  });
});

describe("Task 4.1: Canonical Tab CSS Classes", () => {
  test(".cc-tabs class is defined", () => {
    expect(css).toMatch(/\.cc-tabs\s*\{/);
  });

  test(".cc-tab class is defined", () => {
    expect(css).toMatch(/\.cc-tab\s*\{/);
  });

  test(".cc-tab.active state is defined", () => {
    expect(css).toMatch(/\.cc-tab\.active/);
  });

  test(".cc-tab:hover state is defined", () => {
    expect(css).toMatch(/\.cc-tab:hover/);
  });

  test(".cc-tab-count badge is defined", () => {
    expect(css).toMatch(/\.cc-tab-count/);
  });
});

describe("Task 5.1: Canonical Section Header CSS Classes", () => {
  test(".cc-section-header is defined", () => {
    expect(css).toMatch(/\.cc-section-header\s*\{/);
  });

  test(".cc-section-label is defined", () => {
    expect(css).toMatch(/\.cc-section-label\s*\{/);
  });

  test(".cc-section-chevron is defined", () => {
    expect(css).toMatch(/\.cc-section-chevron/);
  });

  test(".cc-section-count is defined", () => {
    expect(css).toMatch(/\.cc-section-count/);
  });

  test(".cc-section-actions is defined", () => {
    expect(css).toMatch(/\.cc-section-actions/);
  });
});

describe("Task 6.1: Canonical Badge CSS Classes", () => {
  test(".cc-badge base class is defined", () => {
    expect(css).toMatch(/\.cc-badge\s*\{/);
  });

  test(".cc-badge--status modifier is defined", () => {
    expect(css).toMatch(/\.cc-badge--status/);
  });

  test(".cc-badge--type modifier is defined", () => {
    expect(css).toMatch(/\.cc-badge--type/);
  });

  test(".cc-badge--count modifier is defined", () => {
    expect(css).toMatch(/\.cc-badge--count/);
  });

  test(".cc-badge--subtle modifier is defined", () => {
    expect(css).toMatch(/\.cc-badge--subtle/);
  });
});
