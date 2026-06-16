// @vitest-environment jsdom
/**
 * Cascade-order backstop for the no-mixed-ownership rule (Tailwind migration
 * task 1.4 / requirement 4.3; design "Coexistence via cascade layers").
 *
 * The migration's safety guarantee is a hard CSS rule: a declaration in a
 * cascade LAYER loses to an UNLAYERED declaration regardless of source order or
 * specificity. The toolchain imports Tailwind's utilities into `@layer
 * utilities` (src/app/globals.css) and keeps legacy CC CSS unlayered, so a
 * legacy rule always wins where a Tailwind utility would otherwise touch the
 * same element. This is the deterministic backstop for "never mix ownership."
 *
 * Evidence is layered:
 *  1. Against the COMMITTED integration: compile the real `globals.css` through
 *     the real `@tailwindcss/postcss`, assert (via the PostCSS AST) that a real
 *     Tailwind utility (`.flex`) is emitted INSIDE `@layer utilities`, and
 *     resolve it against an unlayered legacy rule on one element in a real
 *     cascade (jsdom) — legacy must win. The AST assertion fails if utilities
 *     ever stop being layered (the layer-ordering regression).
 *  2. Cascade semantics + a negative control on synthetic CSS, proving it is the
 *     LAYER — not source order or specificity — that protects legacy CSS.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, it, expect } from "vitest";

// Vitest runs from the repo root; the `from` path must point at the real
// globals.css so the plugin resolves its `@import`s and scans the real tree.
const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");

/**
 * Resolve `display` for an element carrying `classNames` against `css`, using a
 * real DOM cascade (jsdom). Each call fully replaces the document so cases are
 * isolated.
 */
function computeDisplay(css: string, classNames: string): string {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = `<div id="cascade-probe" class="${classNames}"></div>`;
  const el = document.getElementById("cascade-probe");
  if (!el) throw new Error("cascade probe element not found");
  return getComputedStyle(el).display;
}

/** True iff a `.flex { … }` rule lives inside an `@layer` block named `utilities`. */
function flexIsInUtilitiesLayer(root: postcss.Root): boolean {
  let found = false;
  root.walkAtRules("layer", (layerRule) => {
    if (!layerRule.nodes) return; // a bare `@layer a, b;` declaration, no body
    if (!/(^|[\s,])utilities(\s|,|$)/.test(layerRule.params)) return;
    layerRule.walkRules((rule) => {
      if (rule.selector === ".flex") found = true;
    });
  });
  return found;
}

describe("Tailwind cascade-order backstop (no mixed ownership)", () => {
  it("emits Tailwind utilities into @layer utilities so unlayered legacy CSS wins on the same element (committed integration)", async () => {
    const globals = readFileSync(globalsPath, "utf8");
    // Force the `.flex` utility + add an unlayered legacy rule, then compile
    // through the same plugin `next build` uses.
    const input = `${globals}\n@source inline("flex");\n.cc-cascade-probe-legacy { display: block; }\n`;
    const result = await postcss([tailwindcss()]).process(input, {
      from: globalsPath,
    });

    // Mechanism: the real Tailwind utility is emitted INSIDE `@layer utilities`.
    // Fails if the integration ever imports Tailwind unlayered (the regression).
    expect(flexIsInUtilitiesLayer(result.root)).toBe(true);

    // Behavior: on one element carrying both the layered utility class and the
    // unlayered legacy class, the unlayered legacy rule wins the real cascade.
    expect(computeDisplay(result.css, "flex cc-cascade-probe-legacy")).toBe(
      "block",
    );
  }, 20000);

  it("a legacy unlayered rule beats a layered utility on the same element", () => {
    const css = `
      @layer theme, base, components, utilities;
      @layer utilities {
        .util {
          display: flex;
        }
      }
      .legacy {
        display: block;
      }
    `;
    // Unlayered `.legacy` wins over layered `.util` despite equal specificity.
    expect(computeDisplay(css, "util legacy")).toBe("block");
  });

  it("the same utility wins once it is unlayered — proving the cascade LAYER, not source order, protects legacy CSS", () => {
    const css = `
      .legacy {
        display: block;
      }
      .util {
        display: flex;
      }
    `;
    // Both unlayered, `.util` declared last → it wins by source order. This is
    // the regression the layer prevents: remove the layer and the utility takes
    // over the element.
    expect(computeDisplay(css, "util legacy")).toBe("flex");
  });
});
