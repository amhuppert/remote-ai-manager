#!/usr/bin/env bun
/**
 * CSS ownership inventory + preserved-CSS catalog (Tailwind migration, task 1.1).
 *
 * Produces a repeatable, command-driven report mapping every CSS owner under
 * `src/` to a migration taxonomy and recording the preserved-CSS residual it
 * keeps forever (DOM we do not author in JSX, body atmospherics, scrollbars,
 * keyframes, portal positioning). The taxonomy + residual prose is a CURATED
 * catalog (`OWNERS` below); the marker detection (keyframes, ProseMirror,
 * React Flow, markdown/Mermaid, scrollbars, atmospherics, reduced-motion,
 * breakpoints, block counts) is computed from the live files so the report
 * regenerates exactly and drifts loudly.
 *
 * The script is self-checking: it fails if any `src/**` CSS file is missing
 * from the catalog or any catalog entry no longer exists on disk, so a new or
 * removed stylesheet cannot silently escape the inventory. This feeds the
 * progress ratchet's residual floors (task 6.x) and the conventions doc's
 * do-not-convert catalog (task 1.5).
 *
 * Usage:
 *   bun scripts/css-inventory.ts            # regenerate the committed report
 *   bun scripts/css-inventory.ts --check    # verify catalog↔disk parity and
 *                                           # that the committed report is fresh
 *                                           # (no writes); non-zero exit on drift
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const srcDir = path.join(repoRoot, "src");
const REPORT_MD = path.join(repoRoot, "docs/reports/css-inventory.md");
const REPORT_JSON = path.join(repoRoot, "docs/reports/css-inventory.json");

/**
 * Migration taxonomy (design.md "Existing Architecture Analysis").
 * Every owner gets exactly one PRIMARY taxonomy; interleaved concerns
 * (canonical recipes, generated-content styling, animations) are recorded as
 * `alsoContains` because CC does not keep them in dedicated files.
 */
type Taxonomy =
  | "foundation" // tokens, reset, base typography, the import index, the global entry
  | "canonical-primitive" // shared `.cc-*` recipes that become React primitives
  | "feature-layout" // layout + appearance scoped to one feature surface
  | "generated-content" // styling for renderer output (markdown / syntax / Mermaid)
  | "vendor" // styling for third-party library DOM (React Flow / Tiptap)
  | "animation" // a file dominated by @keyframes
  | "one-off"; // a small single-purpose / placeholder file

interface OwnerSpec {
  /** Path relative to repo root. */
  readonly path: string;
  readonly taxonomy: Taxonomy;
  /** Interleaved secondary taxonomies present in the same file. */
  readonly alsoContains: readonly Taxonomy[];
  /** The preserved-CSS residual this owner keeps forever (or "None preserved"). */
  readonly residual: string;
}

/**
 * Curated owner catalog. The 29 owners enumerated in tasks.md 1.1:
 * globals.css (1) + _root/styles partials (16) + workflow-graph (1) +
 * feature-local stylesheets (11), plus theme.css — the `@theme` token surface
 * added by the Tailwind integration (a new foundation owner).
 */
const OWNERS: readonly OwnerSpec[] = [
  // ---- Foundation ----
  {
    path: "src/app/globals.css",
    taxonomy: "foundation",
    alsoContains: [
      "canonical-primitive",
      "generated-content",
      "animation",
      "one-off",
    ],
    residual:
      "PRESERVED: scrollbar styling (`::-webkit-scrollbar*`); tooltip/modal/toast/notification-panel portal positioning (`.tooltip-portal`, `.modal-overlay`, `.np-backdrop`); the global `@keyframes` library. All Markdown rendering is owned by the canonical Markdown module, so the former global `.markdown-content`/`.markdown-viewer`/`.markdown-fallback` output/shell rules are gone. The leaf-recipe swap wave deleted every consumer-free canonical recipe (`.btn-icon`, `.btn-toggle*`, `.empty-state*`, `.cc-section-*`, `.form-*`, `.cc-toast`); the recipes still present (`.btn*`, `.btn-icon-only*`, `.cc-tabs`/`.cc-tab*`, `.status-dot*`, `.modal*`) each retain ≥1 escape-hatched prod consumer and are tracked above the preserved floor for a follow-up remediation wave (see `.cc/graph-workflow-docs/integration-retained-recipes.md`).",
  },
  {
    path: "src/features/_root/styles/index.css",
    taxonomy: "foundation",
    alsoContains: [],
    residual: "None — pure `@import` aggregator for the 15 _root partials.",
  },
  {
    path: "src/features/_root/styles/tokens.css",
    taxonomy: "foundation",
    alsoContains: [],
    residual:
      "None (no DOM-targeting rules). Entire file is the CSS-custom-property token source and the Stage-A alias-bridge surface for `@theme`; removed only in Stage B token finalization.",
  },
  {
    path: "src/features/_root/styles/reset.css",
    taxonomy: "foundation",
    alsoContains: [],
    residual:
      "PRESERVED: body atmospherics — `body::before` (noise-texture overlay) + `body::after` (scanline overlay) stay scoped forever (decision 4 / R6.2). The base reset (`*`, `html`, `body`) is the reconciled canonical base reset — Preflight is not imported (recommended Option A, pending ratification at the B-final human gate; R9.3). Stays in `@layer base`.",
  },
  {
    path: "src/features/_root/styles/typography.css",
    taxonomy: "foundation",
    alsoContains: ["canonical-primitive"],
    residual:
      "Base element typography preserved as part of the reconciled base reset (Preflight not imported). The dead `.cc-*` typography helpers were deleted; the surviving rules are the utility-shaped `.text-*` color helpers (retire in the R9 token/alias-collapse pass) plus `.cc-diff`.",
  },
  {
    path: "src/features/_root/styles/theme.css",
    taxonomy: "foundation",
    alsoContains: [],
    residual:
      "None (no DOM-targeting rules). The Tailwind v4 `@theme` token surface — currently a minimal sanity token + a spike `@source inline` safelist; the token-bridge context populates the full alias + extract lanes. Imported by globals.css alongside the Tailwind layer imports.",
  },
  // ---- Vendor ----
  {
    path: "src/components/workflow-graph/workflow-graph.css",
    taxonomy: "vendor",
    alsoContains: ["animation"],
    residual:
      "PRESERVED (whole file): targets React Flow (`@xyflow/react`) vendor DOM (`.react-flow__*`, handles, edges, minimap, controls) + its own scrollbars + 7 graph `@keyframes`. Stays bespoke forever (decision 4 / R6.1). Migrated LAST and only its JSX-authored chrome — never the vendor DOM (Stage B 9.1).",
  },
  // ---- Feature-layout (with preserved residuals where present) ----
  {
    path: "src/features/_root/styles/conversation.css",
    taxonomy: "feature-layout",
    alsoContains: ["vendor", "generated-content", "animation"],
    residual:
      "PRESERVED: Tiptap `.ProseMirror` editor DOM; Mermaid output (`.mermaid*`, `mermaid-overlay-fadein`); rendered markdown/code; one `::-webkit-scrollbar`; `@media (prefers-reduced-motion)`; AskQuestion overlay/scrim portal positioning; atmospheric `rainbow-*` keyframes. Only the authored conversation chrome migrates.",
  },
  {
    path: "src/components/session/sidebar/styles/PeekPopover.css",
    taxonomy: "feature-layout",
    alsoContains: ["vendor", "animation"],
    residual:
      "PRESERVED: Tiptap `.ProseMirror` editor DOM (second location, after conversation.css); peek modal portal/backdrop positioning; `peek-*` keyframes. Only the authored peek chrome migrates.",
  },
  {
    path: "src/features/_root/styles/dialogs.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "PRESERVED: modal overlay/backdrop portal positioning for the conflict-resolution dialog (`.cr-*`). Authored dialog content migrates.",
  },
  {
    path: "src/features/_root/styles/keyboard-shortcuts-modal.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "PRESERVED: modal portal positioning (`.hotkey-help*`). Authored content migrates.",
  },
  {
    path: "src/features/project-detail/cockpit/styles/cockpit.css",
    taxonomy: "feature-layout",
    alsoContains: ["animation"],
    residual:
      "PRESERVED: diff slide-over portal positioning (`.plc-diff-*`) + `@media (prefers-reduced-motion)`. `plc-*` keyframes reconciled in the token bridge; cockpit/spawn-card design-system brittle assertions deleted on migration (Stage B 7.7).",
  },
  {
    path: "src/features/_root/styles/prompt.css",
    taxonomy: "feature-layout",
    alsoContains: ["animation"],
    residual:
      "PRESERVED: atmospheric `rainbow-*` keyframes / rainbow-border effect. Authored prompt chrome migrates.",
  },
  {
    path: "src/features/_root/styles/session.css",
    taxonomy: "feature-layout",
    alsoContains: ["animation"],
    residual:
      "None hard-preserved. `session-status-pulse` / `debug-rec-pulse` / `info-details-pop-in` keyframes reconciled in the token bridge; dense authored session layout migrates.",
  },
  {
    path: "src/features/project-detail/styles/project-detail.css",
    taxonomy: "feature-layout",
    alsoContains: ["animation"],
    residual:
      "None hard-preserved. The leaf-recipe swap wave deleted every `.cc-*` recipe (`.cc-primary*`, `.cc-ibtn*`, `.cc-checkbox*`, `.cc-toast`) — all were consumer-free after their ProjectDetailView/CCCheckbox consumers swapped to primitives/inline utilities. What remains: the page-level `.main` layout override (targets a shared shell class), the `.project-detail-shell` flex column, and the preserved `kebab-in` keyframe.",
  },
  {
    path: "src/features/_root/styles/conversation-tabs.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved (`.conversation-tab*` tab strip; add-conversation menu).",
  },
  {
    path: "src/features/_root/styles/conversation-panes.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual: "None preserved (`.pane*` split-screen layout).",
  },
  {
    path: "src/features/_root/styles/sidebar.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved (`.convo-sidebar*`). Responsive layout — incl. the `min-width:769px` desktop companion — transcribes 1:1 via `max-*`/`min-*` variants.",
  },
  {
    path: "src/features/_root/styles/shell.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved (`.app[data-page]` grid template). Responsive layout migrates 1:1.",
  },
  {
    path: "src/features/_root/styles/topbar.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved (`.topbar*`; references the shared `pulse-dot` keyframe).",
  },
  {
    path: "src/features/_root/styles/approval-gate.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved (`.approval-gate*`; references the shared `pulse-dot` keyframe).",
  },
  {
    path: "src/features/_root/spawn-card/spawn-card.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved — fully migratable feature layout (`.spawn-card*`).",
  },
  {
    path: "src/features/projects-index/styles/projects-index.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual:
      "None preserved (`.project-card*`). This is the Stage-A pilot surface (ProjectCard + a leaf control).",
  },
  {
    path: "src/features/session-diff/styles/session-diff.css",
    taxonomy: "feature-layout",
    alsoContains: [],
    residual: "None preserved (`.session-diff-*` full-page diff).",
  },
  // ---- One-off ----
  {
    path: "src/features/_root/styles/sidebar-nav.css",
    taxonomy: "one-off",
    alsoContains: [],
    residual: "None — empty reserved placeholder (comment only, no rules).",
  },
];

interface FileMarkers {
  approxBlocks: number;
  keyframes: string[];
  hasScrollbar: boolean;
  hasProseMirror: boolean;
  hasReactFlow: boolean;
  hasGeneratedContent: boolean;
  hasBodyAtmospherics: boolean;
  hasReducedMotion: boolean;
  breakpointsPx: number[];
}

function analyzeFile(absPath: string): FileMarkers {
  const css = readFileSync(absPath, "utf8");

  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)]
    .map((m) => m[1])
    .filter((name): name is string => Boolean(name))
    .sort();

  const breakpointsPx = [
    ...css.matchAll(/@media[^{]*\(\s*(?:max|min)-width:\s*(\d+)px/g),
  ]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const uniqueBreakpoints = [...new Set(breakpointsPx)].sort((a, b) => a - b);

  return {
    // Count of `{` minus at-rule openers that are not declaration blocks
    // (@keyframes step blocks still count as blocks; this is an honest
    // approximation, not the precise selector count the ratchet computes later).
    approxBlocks: (css.match(/\{/g) ?? []).length,
    keyframes,
    hasScrollbar: /::-webkit-scrollbar|scrollbar-width|scrollbar-color/.test(
      css,
    ),
    hasProseMirror: /\.ProseMirror/.test(css),
    hasReactFlow: /\.react-flow|\.xyflow|react-flow__/.test(css),
    hasGeneratedContent:
      /\.markdown[\w-]*|\.mermaid[\w-]*|\.hljs|\.token\b/.test(css),
    hasBodyAtmospherics: /body::before|body::after/.test(css),
    hasReducedMotion: /prefers-reduced-motion/.test(css),
    breakpointsPx: uniqueBreakpoints,
  };
}

function discoverCssFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".css"))
    .map((rel) => path.posix.join("src", rel.split(path.sep).join("/")))
    .sort();
}

/** Fail if the catalog and disk disagree on the set of owners. */
function assertCatalogParity(discovered: string[]): string[] {
  const catalogPaths = new Set(OWNERS.map((o) => o.path));
  const discoveredSet = new Set(discovered);
  const errors: string[] = [];

  for (const p of discovered) {
    if (!catalogPaths.has(p)) {
      errors.push(`UNCATALOGUED: ${p} exists on disk but is not in OWNERS.`);
    }
  }
  for (const o of OWNERS) {
    if (!discoveredSet.has(o.path)) {
      errors.push(`STALE: ${o.path} is in OWNERS but not found on disk.`);
    }
    if (!existsSync(path.join(repoRoot, o.path))) {
      errors.push(`MISSING: ${o.path} catalog path does not resolve.`);
    }
  }

  const seen = new Set<string>();
  for (const o of OWNERS) {
    if (seen.has(o.path))
      errors.push(`DUPLICATE: ${o.path} appears twice in OWNERS.`);
    seen.add(o.path);
  }
  return errors;
}

interface OwnerReport extends OwnerSpec {
  markers: FileMarkers;
}

function buildReports(): OwnerReport[] {
  return OWNERS.map((owner) => ({
    ...owner,
    markers: analyzeFile(path.join(repoRoot, owner.path)),
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function markerFlags(m: FileMarkers): string {
  const flags: string[] = [];
  if (m.hasReactFlow) flags.push("react-flow");
  if (m.hasProseMirror) flags.push("ProseMirror");
  if (m.hasGeneratedContent) flags.push("markdown/Mermaid");
  if (m.hasBodyAtmospherics) flags.push("body-atmospherics");
  if (m.hasScrollbar) flags.push("scrollbars");
  if (m.keyframes.length > 0) flags.push(`keyframes×${m.keyframes.length}`);
  if (m.hasReducedMotion) flags.push("reduced-motion");
  return flags.length > 0 ? flags.join(", ") : "—";
}

function renderMarkdown(reports: OwnerReport[]): string {
  const generatedBy =
    "Regenerate with `bun scripts/css-inventory.ts` (verify with `--check`).";
  const totalBlocks = reports.reduce((n, r) => n + r.markers.approxBlocks, 0);

  const byTaxonomy = new Map<Taxonomy, OwnerReport[]>();
  for (const r of reports) {
    const list = byTaxonomy.get(r.taxonomy) ?? [];
    list.push(r);
    byTaxonomy.set(r.taxonomy, list);
  }

  const lines: string[] = [];
  lines.push("# CSS Ownership Inventory & Preserved-CSS Catalog");
  lines.push("");
  lines.push("> GENERATED FILE — do not edit by hand. " + generatedBy);
  lines.push(
    "> Source of truth: the `OWNERS` catalog in `scripts/css-inventory.ts` " +
      "(taxonomy + residual prose) plus live marker detection over `src/**/*.css`.",
  );
  lines.push("");
  lines.push(
    "Tailwind migration task 1.1 (requirements 6.1, 6.2, 7.1, 8.1). Maps every " +
      "CSS owner to a migration **taxonomy** and records the **preserved-CSS " +
      "residual** it keeps forever. Feeds the progress ratchet's residual floors " +
      "(task 6.x) and the conventions doc's do-not-convert catalog (task 1.5).",
  );
  lines.push("");
  lines.push(
    `**Owners:** ${reports.length} CSS files under \`src/\` · ` +
      `**approx. declaration blocks:** ${totalBlocks}.`,
  );
  lines.push("");

  // ---- Taxonomy legend ----
  lines.push("## Taxonomy");
  lines.push("");
  lines.push("| Taxonomy | Meaning |");
  lines.push("| --- | --- |");
  lines.push(
    "| `foundation` | tokens, reset, base typography, the import index, the global entry stylesheet |",
  );
  lines.push(
    "| `canonical-primitive` | shared `.cc-*` recipes that become React primitives |",
  );
  lines.push(
    "| `feature-layout` | layout + appearance scoped to one feature surface |",
  );
  lines.push(
    "| `generated-content` | styling for renderer output (markdown / syntax-highlighter / Mermaid) |",
  );
  lines.push(
    "| `vendor` | styling for third-party library DOM (React Flow / Tiptap) |",
  );
  lines.push("| `animation` | a file dominated by `@keyframes` |");
  lines.push("| `one-off` | a small single-purpose / placeholder file |");
  lines.push("");
  lines.push(
    "Each owner gets one **primary** taxonomy. `canonical-primitive`, " +
      "`generated-content`, and `animation` have **no dedicated file** in CC — " +
      "the `.cc-*` recipes live appended in `globals.css` / `typography.css`; " +
      "markdown/Mermaid styling lives inside `globals.css` " +
      "/ `conversation.css`; keyframes are interleaved throughout. These are " +
      "surfaced as **also-contains** below and enumerated in the preserved-CSS " +
      "catalog.",
  );
  lines.push("");

  // ---- Master table ----
  lines.push("## Owner inventory");
  lines.push("");
  lines.push(
    "| Owner | Taxonomy | Also contains | ~blocks | Detected markers | Preserved-CSS residual |",
  );
  lines.push("| --- | --- | --- | ---: | --- | --- |");
  for (const r of reports) {
    const also =
      r.alsoContains.length > 0
        ? r.alsoContains.map((t) => `\`${t}\``).join(", ")
        : "—";
    lines.push(
      `| \`${r.path}\` | \`${r.taxonomy}\` | ${also} | ${r.markers.approxBlocks} | ${markerFlags(r.markers)} | ${r.residual} |`,
    );
  }
  lines.push("");

  // ---- Grouped by taxonomy ----
  lines.push("## By taxonomy");
  lines.push("");
  const order: Taxonomy[] = [
    "foundation",
    "vendor",
    "feature-layout",
    "canonical-primitive",
    "generated-content",
    "animation",
    "one-off",
  ];
  for (const tax of order) {
    const list = byTaxonomy.get(tax);
    if (!list || list.length === 0) {
      lines.push(`### \`${tax}\` — 0 owners`);
      lines.push("");
      lines.push(
        "No file has this as its **primary** taxonomy; it appears only as an interleaved concern (see also-contains + preserved-CSS catalog).",
      );
      lines.push("");
      continue;
    }
    lines.push(`### \`${tax}\` — ${list.length} owner(s)`);
    lines.push("");
    for (const r of list) lines.push(`- \`${r.path}\``);
    lines.push("");
  }

  // ---- Preserved-CSS do-not-convert catalog ----
  lines.push("## Preserved-CSS do-not-convert catalog");
  lines.push("");
  lines.push(
    "DOM CC does not author in JSX, body atmospherics, scrollbars, keyframes, " +
      "and portal positioning stay as scoped CSS forever (decision 4 / R6). " +
      "Detected occurrences (live, by marker):",
  );
  lines.push("");
  const collect = (pred: (m: FileMarkers) => boolean) =>
    reports.filter((r) => pred(r.markers)).map((r) => `\`${r.path}\``);
  const catalog: Array<[string, string[]]> = [
    [
      "React Flow vendor DOM (`.react-flow*` / `.xyflow*`)",
      collect((m) => m.hasReactFlow),
    ],
    ["Tiptap `.ProseMirror` editor DOM", collect((m) => m.hasProseMirror)],
    [
      "Markdown / syntax-highlighter / Mermaid output",
      collect((m) => m.hasGeneratedContent),
    ],
    [
      "Body atmospherics (`body::before` / `body::after`)",
      collect((m) => m.hasBodyAtmospherics),
    ],
    ["Scrollbars (`::-webkit-scrollbar*`)", collect((m) => m.hasScrollbar)],
    ["`@keyframes` definitions", collect((m) => m.keyframes.length > 0)],
    [
      "Reduced-motion blocks (`prefers-reduced-motion`)",
      collect((m) => m.hasReducedMotion),
    ],
  ];
  lines.push("| Preserved category | Owners holding it |");
  lines.push("| --- | --- |");
  for (const [label, owners] of catalog) {
    lines.push(`| ${label} | ${owners.length > 0 ? owners.join(", ") : "—"} |`);
  }
  lines.push("");
  lines.push(
    "Portal/overlay positioning is preserved per R6.2 but is not a single " +
      "machine-detectable token; it is recorded per-owner in the residual column " +
      "(globals.css tooltip/modal/toast, conversation.css AskQuestion overlay, " +
      "dialogs.css `.cr-*`, keyboard-shortcuts-modal, cockpit.css diff slide-over, " +
      "PeekPopover backdrop).",
  );
  lines.push("");

  // ---- Keyframes census ----
  lines.push("## `@keyframes` census");
  lines.push("");
  lines.push("| Owner | Keyframes |");
  lines.push("| --- | --- |");
  for (const r of reports) {
    if (r.markers.keyframes.length === 0) continue;
    lines.push(
      `| \`${r.path}\` | ${r.markers.keyframes.map((k) => `\`${k}\``).join(", ")} |`,
    );
  }
  lines.push("");

  return lines.join("\n") + "\n";
}

function renderJson(reports: OwnerReport[]): string {
  return (
    JSON.stringify(
      {
        note: "Generated by scripts/css-inventory.ts. Do not edit by hand.",
        ownerCount: reports.length,
        owners: reports.map((r) => ({
          path: r.path,
          taxonomy: r.taxonomy,
          alsoContains: r.alsoContains,
          residual: r.residual,
          markers: r.markers,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const discovered = discoverCssFiles();
  const parityErrors = assertCatalogParity(discovered);

  if (parityErrors.length > 0) {
    console.error("CSS inventory catalog is out of sync with disk:\n");
    for (const e of parityErrors) console.error(`  - ${e}`);
    console.error(
      "\nUpdate the OWNERS catalog in scripts/css-inventory.ts to match `src/**/*.css`.",
    );
    process.exit(1);
  }

  const reports = buildReports();
  const md = renderMarkdown(reports);
  const json = renderJson(reports);

  if (checkMode) {
    const staleMd =
      !existsSync(REPORT_MD) || readFileSync(REPORT_MD, "utf8") !== md;
    const staleJson =
      !existsSync(REPORT_JSON) || readFileSync(REPORT_JSON, "utf8") !== json;
    if (staleMd || staleJson) {
      console.error(
        "CSS inventory report is stale. Run `bun scripts/css-inventory.ts` and commit the result.",
      );
      process.exit(1);
    }
    console.log(
      `CSS inventory OK — ${reports.length} owners catalogued, report fresh.`,
    );
    return;
  }

  writeFileSync(REPORT_MD, md);
  writeFileSync(REPORT_JSON, json);
  console.log(
    `CSS inventory written: ${reports.length} owners → ` +
      `${path.relative(repoRoot, REPORT_MD)} + ${path.relative(repoRoot, REPORT_JSON)}`,
  );
}

main();
