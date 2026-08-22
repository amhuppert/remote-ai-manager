/**
 * Design-system guarantees that live in the graph stylesheet rather than in a
 * component, and so cannot be asserted by rendering: jsdom applies no external
 * stylesheet. Parsed with postcss, matching `design-system-guarantees.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const CSS_PATH = path.resolve(__dirname, "./workflow-graph.css");

function rules(): Rule[] {
  const found: Rule[] = [];
  postcss.parse(readFileSync(CSS_PATH, "utf8")).walkRules((rule) => {
    found.push(rule);
  });
  return found;
}

function declarationsFor(predicate: (selector: string) => boolean): string[] {
  return rules()
    .filter((rule) => predicate(rule.selector))
    .flatMap((rule) =>
      rule.nodes
        .filter((node) => node.type === "decl")
        .map((node) => `${node.prop}: ${node.value}`),
    );
}

describe("graph edge focus treatment", () => {
  /**
   * React Flow makes a selectable edge keyboard-focusable and its own stylesheet
   * clears the wrapper outline, so tabbing to an edge is invisible unless the
   * graph stylesheet draws the focus itself. An SVG group cannot carry a
   * reliable outline either, which is why the treatment lands on the line.
   */
  it("draws a visible focus treatment on the focused edge line", () => {
    const focusDecls = declarationsFor(
      (selector) =>
        selector.includes(":focus-visible") && selector.includes(".edge-line"),
    );

    expect(focusDecls.length).toBeGreaterThan(0);
    expect(focusDecls.some((decl) => decl.startsWith("stroke:"))).toBe(true);
  });

  /**
   * Focus and selection are different states — an edge can be focused without
   * being selected — so the focus treatment must not be spelled only as part of
   * the `.selected` recolour.
   */
  it("keeps the focus treatment separate from the selected recolour", () => {
    const focusSelectors = rules()
      .map((rule) => rule.selector)
      .filter((selector) => selector.includes(":focus-visible"));

    expect(
      focusSelectors.some((selector) => !selector.includes(".selected")),
    ).toBe(true);
  });
});

describe("graph reduced-motion guarantee", () => {
  it("disables every graph animation under prefers-reduced-motion", () => {
    const root = postcss.parse(readFileSync(CSS_PATH, "utf8"));

    const animated = new Set<string>();
    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule") return;
      rule.walkDecls("animation", () => {
        for (const selector of rule.selectors) animated.add(selector.trim());
      });
    });

    const silenced = new Set<string>();
    root.walkAtRules("media", (at) => {
      if (!at.params.includes("prefers-reduced-motion")) return;
      at.walkRules((rule) => {
        for (const selector of rule.selectors) silenced.add(selector.trim());
      });
    });

    for (const selector of animated) {
      expect(silenced).toContain(selector);
    }
  });
});
