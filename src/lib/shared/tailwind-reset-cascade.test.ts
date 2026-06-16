// @vitest-environment jsdom
/**
 * Reset-vs-utilities cascade regression (Tailwind migration — Stage A foundation
 * amendment; requirements 3.x/4.x; design "Coexistence via cascade layers").
 *
 * CC's reset.css carries a UNIVERSAL `*,*::before,*::after { margin:0; padding:0 }`
 * rule. Cascade layers outrank specificity, so while that rule was UNLAYERED it
 * beat EVERY Tailwind spacing utility (`p-*`/`m-*`/`gap-*`) on EVERY element —
 * even though `.p-xl` (0,1,0) out-specifies `*` (0,0,0) — making utility-authored
 * spacing dead on arrival and parity impossible (measured: a migrated card's
 * `p-xl` resolved to 0). The fix imports ONLY reset.css into `@layer base`
 * (src/features/_root/styles/index.css), so the precedence order becomes:
 *
 *   @layer base (reset)  <  @layer utilities (Tailwind)  <  unlayered (feature CSS)
 *
 * jsdom does NOT implement `@layer` precedence (a declaration whose only match is
 * inside a layer computes to empty), so "a layered utility beats the layered
 * reset" cannot be asserted via computed styles here — it is proven structurally
 * (the compiled CSS places the reset in `base`, the utility in `utilities`, and
 * declares `base` before `utilities`, which deterministically makes utilities win
 * per the CSS cascade-layer spec) and visually by the pilot before/after
 * screenshots. This test fails if reset.css is ever un-layered again, which is
 * exactly the regression that reintroduces the zero-padding bug. It is the
 * spacing counterpart to tailwind-cascade-order.test.ts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, it, expect } from "vitest";

const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");

/** Effective layer order: every bare `@layer a, b, …;` declaration, in document
 *  order, flattened (CSS concatenates them into one ordering). */
function layerStatementOrder(root: postcss.Root): string[] {
  const order: string[] = [];
  root.walkAtRules("layer", (layer) => {
    if (layer.nodes) return; // skip `@layer name { … }` blocks
    for (const name of layer.params.split(",").map((s) => s.trim())) {
      if (name) order.push(name);
    }
  });
  return order;
}

/** True iff a universal selector with `padding: 0` lives inside `@layer <name>`. */
function universalPaddingZeroInLayer(
  root: postcss.Root,
  name: string,
): boolean {
  let found = false;
  root.walkAtRules("layer", (layer) => {
    if (!layer.nodes) return;
    if (!new RegExp(`(^|[\\s,])${name}(\\s|,|$)`).test(layer.params)) return;
    layer.walkDecls("padding", (decl) => {
      if (
        decl.value === "0" &&
        (decl.parent as postcss.Rule)?.selector?.includes("*")
      ) {
        found = true;
      }
    });
  });
  return found;
}

/** True iff an unlayered (top-level) rule sets `padding: 0` on a universal selector. */
function hasUnlayeredUniversalPaddingZero(root: postcss.Root): boolean {
  let found = false;
  root.walkRules((rule) => {
    // A rule is unlayered iff none of its ancestors is an `@layer …{}` block.
    let parent: postcss.Container | undefined =
      rule.parent as postcss.Container;
    while (parent) {
      if (
        parent.type === "atrule" &&
        (parent as postcss.AtRule).name === "layer"
      ) {
        return;
      }
      parent = parent.parent as postcss.Container | undefined;
    }
    if (!rule.selector.includes("*")) return;
    rule.walkDecls("padding", (decl) => {
      if (decl.value === "0") found = true;
    });
  });
  return found;
}

/** True iff a `.<className>` rule lives inside `@layer utilities`. */
function selectorInUtilitiesLayer(
  root: postcss.Root,
  selector: string,
): boolean {
  let found = false;
  root.walkAtRules("layer", (layer) => {
    if (!layer.nodes) return;
    if (!/(^|[\s,])utilities(\s|,|$)/.test(layer.params)) return;
    layer.walkRules((rule) => {
      if (rule.selector === selector) found = true;
    });
  });
  return found;
}

/** Resolve `padding-left` for an element carrying `classNames` against `css`. */
function computePaddingLeft(css: string, classNames: string): string {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = `<div id="reset-probe" class="${classNames}"></div>`;
  const el = document.getElementById("reset-probe");
  if (!el) throw new Error("reset probe element not found");
  return getComputedStyle(el).paddingLeft;
}

describe("Tailwind reset-vs-utilities cascade (spacing parity backstop)", () => {
  it("compiles the reset into @layer base, the spacing utility into @layer utilities, with base declared before utilities (so utilities win)", async () => {
    const globals = readFileSync(globalsPath, "utf8");
    const input = `${globals}\n@source inline("p-[24px]");\n`;
    const result = await postcss([tailwindcss()]).process(input, {
      from: globalsPath,
    });
    const root = result.root;

    // The reset's universal padding:0 lives in @layer base (not unlayered).
    expect(universalPaddingZeroInLayer(root, "base")).toBe(true);

    // And it is NOT also present unlayered — the regression would re-add it there.
    expect(hasUnlayeredUniversalPaddingZero(root)).toBe(false);

    // The forced spacing utility lands in @layer utilities.
    expect(selectorInUtilitiesLayer(root, ".p-\\[24px\\]")).toBe(true);

    // Layer order: base before utilities → every utilities declaration beats
    // every base declaration per the cascade-layer spec, so `p-*` beats the reset.
    const order = layerStatementOrder(root);
    expect(order).toContain("base");
    expect(order).toContain("utilities");
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("utilities"));
  }, 20000);

  it("negative control: an UNLAYERED universal reset beats a layered utility despite lower specificity (the pre-fix bug)", () => {
    const css = `
      @layer theme, base, components, utilities;
      @layer utilities {
        .p { padding: 24px; }
      }
      * { padding: 0; }
    `;
    // Unlayered `*` (0,0,0) beats layered `.p` (0,1,0) because layer precedence
    // outranks specificity — reproducing the zero-padding bug the fix removed.
    // (jsdom applies unlayered rules but ignores layered ones, matching the real
    // outcome here.)
    expect(computePaddingLeft(css, "p")).toBe("0px");
  });
});
