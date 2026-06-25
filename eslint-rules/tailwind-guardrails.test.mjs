/**
 * Demonstrates the Tailwind migration guardrails (design 5.2; R7.5/8.3/8.4):
 * each of the four rules FAILS on a sample violation and PASSES on the patterns
 * the migrated pilot and committed primitives actually use. `npx eslint .`
 * exiting 0 proves it on the real files; these RuleTester cases pin the behavior
 * per-rule in CI.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import css from "@eslint/css";
import { describe } from "vitest";
import plugin from "./tailwind-guardrails.mjs";

// Same shape as the css block in eslint.config.mjs.
const APPROVED_AREAS = [
  "/features/_root/styles/",
  "/components/workflow-graph/",
];
const GRANDFATHERED = [
  "/features/projects-index/styles/projects-index.css",
  "/features/config/styles/config-editor.css",
];
const CSS_OPTS = [
  { approvedAreas: APPROVED_AREAS, grandfathered: GRANDFATHERED },
];

const tsx = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const cssTester = new RuleTester({
  plugins: { css },
  language: "css/css",
});

describe("tailwind-guardrails", () => {
  // (8.3a) dynamically-constructed class strings — direct AND indirect
  tsx.run("no-dynamic-class", plugin.rules["no-dynamic-class"], {
    valid: [
      // Sanctioned: cn() with static strings, logical, static map.
      { code: `cn("flex items-center", cond && "opacity-50", map[variant]);` },
      { code: `const x = <div className={CARD_CLASS} />;` },
      { code: `const x = <div className="mb-md flex items-start" />;` },
      // Module-const composition of SPACE-separated complete strings (the real
      // ProjectCard CARD_CLASS pattern) — resolved through the identifier and not
      // "glued", so allowed.
      { code: "const C = `${A} ${B} ${C2}`; const x = <div className={C} />;" },
      { code: `const C = "px-3 " + "py-2"; const x = <div className={C} />;` },
      // Static class map (the primitive variantClass/sizeClass pattern) with
      // static values — resolved through member access, not dynamic.
      {
        code: `const variantClass = { danger: "bg-bg-surface border-border-default" }; const c = cn(variantClass[variant]);`,
      },
      // href interpolation is unrelated to classes.
      { code: "const x = <a href={`/p/${id}`} className={NAME} />;" },
    ],
    invalid: [
      // Direct glued interpolation.
      {
        code: "const x = <div className={`bg-${tone}-500`} />;",
        errors: [{ messageId: "dynamic" }],
      },
      // Indirect: assigned to a var, then used in className (the reopened gap).
      {
        code: "const cls = `bg-${tone}-500`; const x = <div className={cls} />;",
        errors: [{ messageId: "dynamic" }],
      },
      // Indirect via cn().
      {
        code: "const cls = `text-${size}`; const c = cn(cls);",
        errors: [{ messageId: "dynamic" }],
      },
      // Dynamic value inside a static MAP, accessed by member (the reopened gap).
      {
        code: "const variantClass = { danger: `bg-${tone}-500` }; const c = cn(variantClass.danger);",
        errors: [{ messageId: "dynamic" }],
      },
      // Same via a computed (dynamic) key — every value is a candidate.
      {
        code: "const m = { danger: `bg-${tone}-500` }; const c = cn(m[key]);",
        errors: [{ messageId: "dynamic" }],
      },
      // Non-static `+` concatenation.
      {
        code: `const x = <div className={"a " + cond} />;`,
        errors: [{ messageId: "dynamic" }],
      },
      {
        code: "const c = cn(`px-${size}`);",
        errors: [{ messageId: "dynamic" }],
      },
    ],
  });

  // (8.3b) hard-coded colors — hex AND rgb()/rgba()/hsl()
  tsx.run("no-hardcoded-color", plugin.rules["no-hardcoded-color"], {
    valid: [
      {
        code: `const x = <div className="bg-bg-surface text-text-primary border-border-subtle" />;`,
      },
      // Post-fix pilot/primitive pattern: composite values reference tokens via var().
      {
        code: `const x = <div className="shadow-[0_0_6px_var(--cyan-glow)]" />;`,
      },
      {
        code: `const x = <div className="shadow-[inset_3px_0_8px_-4px_var(--cyan-glow),0_0_16px_-4px_var(--cc-cyan-a12)]" />;`,
      },
      { code: `const c = cn("border-[var(--cc-red-border)]");` },
      { code: `const x = <div className="bg-[var(--cc-overlay-scrim)]" />;` },
      {
        code: `const x = <div className="before:bg-[linear-gradient(90deg,transparent,var(--cyan-dim),transparent)]" />;`,
      },
      // Static class map with tokenized values (the real primitive pattern).
      {
        code: `const variantClass = { danger: "border-[var(--cc-red-border)] text-red" }; const c = cn(variantClass[variant]);`,
      },
    ],
    invalid: [
      {
        code: `const x = <div className="bg-[#ff0000]" />;`,
        errors: [{ messageId: "color" }],
      },
      // Hard-coded color in a CONST, then used in className (the reopened gap).
      {
        code: `const BAD = "bg-[#ff0000]"; const x = <div className={BAD} />;`,
        errors: [{ messageId: "color" }],
      },
      // Hard-coded rgba in a const passed to cn() (the reopened gap).
      {
        code: `const BAD = "border-[rgba(255,61,90,0.3)]"; const c = cn(BAD);`,
        errors: [{ messageId: "color" }],
      },
      // Hard-coded color inside a static MAP, accessed by member.
      {
        code: `const m = { danger: "border-[#243048]" }; const c = cn(m.danger);`,
        errors: [{ messageId: "color" }],
      },
      {
        code: `const x = <div className="text-[#fff]" />;`,
        errors: [{ messageId: "color" }],
      },
      // rgba inside a composite shadow utility (the reopened gap).
      {
        code: `const x = <div className="shadow-[0_0_6px_rgba(0,229,255,0.15)]" />;`,
        errors: [{ messageId: "color" }],
      },
      {
        code: `const c = cn("border-[rgba(255,61,90,0.3)]");`,
        errors: [{ messageId: "color" }],
      },
      {
        code: `const x = <div className="bg-[hsl(200,50%,50%)]" />;`,
        errors: [{ messageId: "color" }],
      },
    ],
  });

  // (8.3d) appearance utilities passed to a primitive's layoutClassName
  tsx.run(
    "no-appearance-in-layout-classname",
    plugin.rules["no-appearance-in-layout-classname"],
    {
      valid: [
        { code: `const x = <Button layoutClassName="ml-auto" />;` },
        { code: `const x = <Tabs layoutClassName="w-full" />;` },
        { code: `const x = <ModalShell layoutClassName="max-w-[640px]" />;` },
        {
          code: `const x = <StatusDot layoutClassName="mr-2 self-start order-2" />;`,
        },
        // className is owned by the primitive's recipe — this rule ignores it.
        { code: `const x = <div className="bg-red-500 rounded-lg" />;` },
        // Identifier-backed layout-only value resolves and passes.
        {
          code: `const layout = "ml-auto"; const x = <Button layoutClassName={layout} />;`,
        },
        // Area-based grid placement (drops a primitive into a parent's
        // grid-template-areas) is placement, like the line-based col-*/row-*.
        {
          code: `const x = <ModeDot layoutClassName="max-768:[grid-area:mode] max-768:self-center" />;`,
        },
        // Responsive display toggle removes a child from the parent's responsive
        // grid/flow at a breakpoint — layout flow, not appearance.
        {
          code: `const x = <StatusPill layoutClassName="max-768:hidden" />;`,
        },
        // Flex sizing + overflow clipping + content truncation: how a parent
        // constrains a flex child to its box (parity reproduction of the legacy
        // `.wb-inspector-header .cc-tabs/.cc-tab` descendant rules). Flow/clipping,
        // not appearance.
        {
          code: `const x = <Tabs layoutClassName="flex-[1_1_auto] min-w-0 overflow-hidden" />;`,
        },
        {
          code: `const x = <Tab layoutClassName="min-w-0 overflow-hidden text-ellipsis" />;`,
        },
        { code: `const x = <Tab layoutClassName="truncate" />;` },
        // min-h is the flexbox min-height:0 sizing fix — the height counterpart of
        // the already-allowed min-w, used to let a nested Tabs flex child shrink so
        // its panel can scroll. Pure geometry, not appearance.
        {
          code: `const x = <TabsContent layoutClassName="flex min-h-0 flex-1 flex-col" />;`,
        },
        // State-variant display toggling: a force-mounted TabsContent drives its
        // own visibility off Radix data-state (Preflight is off, so the bare
        // `hidden` attribute loses to an author display utility). The bracketed
        // `data-[state=…]:` variant must strip to its allowed core (flex/hidden).
        {
          code: `const x = <TabsContent layoutClassName="data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden" />;`,
        },
      ],
      invalid: [
        {
          code: `const x = <Button layoutClassName="bg-red-500" />;`,
          errors: [{ messageId: "appearance" }],
        },
        // Appearance utility passed through a CONST (the reopened gap).
        {
          code: `const layout = "bg-red-500"; const x = <Button layoutClassName={layout} />;`,
          errors: [{ messageId: "appearance" }],
        },
        // Appearance utility passed through a static MAP member.
        {
          code: `const m = { x: "text-cyan" }; const el = <Badge layoutClassName={m.x} />;`,
          errors: [{ messageId: "appearance" }],
        },
        {
          code: `const x = <Badge layoutClassName="text-cyan" />;`,
          errors: [{ messageId: "appearance" }],
        },
        {
          code: `const x = <Button layoutClassName="p-4" />;`,
          errors: [{ messageId: "appearance" }],
        },
        {
          code: `const x = <Button layoutClassName="shadow-lg ml-auto" />;`,
          errors: [{ messageId: "appearance" }],
        },
        // Stripping bracketed `data-[…]:` variants must not create a false
        // negative: an appearance utility behind a state variant still fails on
        // its core (bg-red-500), only the variant prefix is removed.
        {
          code: `const x = <TabsContent layoutClassName="data-[state=active]:bg-red-500" />;`,
          errors: [{ messageId: "appearance" }],
        },
      ],
    },
  );

  // (8.4) new global CSS outside approved foundation/vendor areas
  cssTester.run(
    "no-unapproved-global-css",
    plugin.rules["no-unapproved-global-css"],
    {
      valid: [
        {
          code: `.x { color: red; }`,
          filename: "src/features/_root/styles/typography.css",
          options: CSS_OPTS,
        },
        {
          code: `.y { color: red; }`,
          filename: "src/components/workflow-graph/workflow-graph.css",
          options: CSS_OPTS,
        },
        {
          code: `.z { color: red; }`,
          filename: "src/features/projects-index/styles/projects-index.css",
          options: CSS_OPTS,
        },
      ],
      invalid: [
        // NEW stylesheet under a feature styles dir (the reopened gap): feature
        // styles dirs are migration debt, not an approved area.
        {
          code: `.bad { color: red; }`,
          filename: "src/features/projects-index/styles/new-global.css",
          options: CSS_OPTS,
          errors: [{ messageId: "unapproved" }],
        },
        // CSS next to a component.
        {
          code: `.bad { color: red; }`,
          filename: "src/components/ui/oops.css",
          options: CSS_OPTS,
          errors: [{ messageId: "unapproved" }],
        },
      ],
    },
  );
});
