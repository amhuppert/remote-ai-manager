#!/usr/bin/env bun
/**
 * Owner-level CSS migration progress ratchet (Tailwind migration, task 6.1).
 *
 * Reports remaining CSS BY OWNER using **selector count per owner** as the unit
 * (decision, Alex 2026-06-15 — more honest about partial migration than file or
 * line count) and enforces a monotonic ratchet so the migration cannot silently
 * stall or accrue new styling debt (requirements 6.4, 8.1, 8.2).
 *
 * The unit (`countTrackedSelectors`): the number of DOM-targeting selectors an
 * owner still declares — every selector in a style rule (a comma-separated
 * selector list counts as N), plus one per `@keyframes` definition. Keyframe
 * *step* rules (`0%`, `from`, `to`), `@theme`/`@import`/`@layer`/`@font-face`
 * and other non-selector at-rules do not count. The count is computed from a
 * real PostCSS AST, not a regex over CSS text, so it does not drift the way the
 * inventory's `approxBlocks` brace-count does (which is an honest approximation
 * by design — this is the precise figure the ratchet promised).
 *
 * The ratchet (per the task's acceptance criteria, which resolves the looser
 * phrasing in design.md "Guardrails + Progress Ratchet" §"Migrated predicate"):
 * an owner's **tracked count** is its total selector count; each owner declares
 * a **residual floor** — the scoped CSS it keeps forever (preserved owners
 * declare a non-zero floor: React Flow vendor DOM, `.ProseMirror`, body
 * atmospherics, scrollbars/keyframes, portal positioning per decision 4 / R6;
 * fully-migratable owners declare ~0). A run FAILS when any owner's count
 *   - increases above its recorded baseline (new debt / regression), OR
 *   - drops below its declared floor (a preserved-forever rule was deleted).
 * A valid decrease (floor ≤ count < baseline) PASSES; that is the migration
 * making progress. The committed baseline (`docs/reports/css-migration-baseline.json`)
 * is the high-water mark and only ratchets down — write mode refuses to record
 * an increase, so the baseline can never silently rise.
 *
 * Floors are DECLARED CONSTANTS (`OWNER_FLOORS`), derived from the inventory /
 * preserved-CSS catalog (`scripts/css-inventory.ts` + `docs/reports/css-inventory.md`).
 * They are deliberately conservative lower bounds for the portal-positioning
 * residuals the AST cannot machine-detect: a lower floor never causes a false CI
 * failure (it only relaxes the below-floor tripwire), so a wave that legitimately
 * migrates authored chrome is never blocked. Stage B 9.2 tightens them once each
 * preserved owner's true residual is exposed by its migration.
 *
 * Usage:
 *   bun scripts/css-migration-progress.ts            # regenerate the baseline
 *                                                    # (ratchets it down to the
 *                                                    # current counts; refuses to
 *                                                    # record an increase) + print
 *                                                    # the per-owner report
 *   bun scripts/css-migration-progress.ts --check    # CI gate: read-only; non-zero
 *                                                    # exit if any owner increased,
 *                                                    # dropped below its floor, or a
 *                                                    # new untracked CSS owner appeared
 *
 * Wired as the `css:progress` package script so larger feature waves can invoke
 * it in CI (task 6.1 / R8.1, R8.2).
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Rule } from "postcss";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const srcDir = path.join(repoRoot, "src");
const BASELINE_JSON = path.join(
  repoRoot,
  "docs/reports/css-migration-baseline.json",
);

/**
 * Per-owner floor catalog (preserved-owner allowlist + declared residual floors).
 *
 * Every `src/**` CSS owner must appear here (parity is enforced against disk, so
 * a new stylesheet fails loudly as untracked debt). `preserved: true` owners keep
 * scoped CSS forever and declare a NON-ZERO floor; fully-migratable owners declare
 * `floor: 0` (the file is deleted, or shrinks to nothing, by end-state).
 *
 * Floors are derived from `docs/reports/css-inventory.md` (the preserved-CSS
 * catalog) — see each `note`. Lower bounds by intent (see file header).
 */
export interface OwnerFloor {
  /** Path relative to repo root. */
  readonly path: string;
  /** Keeps scoped CSS forever (declares a non-zero residual floor). */
  readonly preserved: boolean;
  /** Selectors+keyframes this owner may never drop below. */
  readonly floor: number;
  /** Why this floor (catalog residual it encodes), or migration target. */
  readonly note: string;
}

export const OWNER_FLOORS: readonly OwnerFloor[] = [
  // ---- Preserved owners (non-zero residual floors) ----
  {
    path: "src/app/globals.css",
    preserved: true,
    floor: 66,
    note: "Scrollbars + rendered-markdown output + the 21-keyframe global library + tooltip/modal/toast portal positioning stay forever (catalog residual).",
  },
  {
    path: "src/components/workflow-graph/workflow-graph.css",
    preserved: true,
    floor: 58,
    note: "React Flow vendor DOM + own scrollbars + 7 graph keyframes + the `.wb-markdown-inline*` rendered-markdown output (preserved per R6) stay bespoke forever; the JSX-authored chrome was migrated to utilities (Stage B 9.1 / B-6 graph-builder). Floor is the actual post-migration preserved residual (58), corrected up from the earlier conservative 33 which omitted the ~25 `.wb-markdown-inline*` selectors.",
  },
  {
    path: "src/features/_root/styles/conversation.css",
    preserved: true,
    floor: 39,
    note: "Tiptap `.ProseMirror` + Mermaid/markdown output + scrollbar + prefers-reduced-motion + AskQuestion overlay + rainbow keyframes stay forever.",
  },
  {
    path: "src/features/_root/styles/reset.css",
    preserved: true,
    floor: 2,
    note: "Body atmospherics — `body::before` (noise) + `body::after` (scanline) — stay scoped forever (decision 4 / R6.2).",
  },
  {
    path: "src/features/_root/styles/prompt.css",
    preserved: true,
    floor: 2,
    note: "Atmospheric rainbow-border effect stays scoped (catalog residual). Authored prompt chrome migrates.",
  },
  {
    path: "src/features/_root/styles/dialogs.css",
    preserved: true,
    floor: 3,
    note: "Conflict-resolution modal overlay/backdrop portal positioning (`.cr-*`) stays scoped. Authored content migrates.",
  },
  {
    path: "src/features/_root/styles/keyboard-shortcuts-modal.css",
    preserved: true,
    floor: 2,
    note: "Modal portal positioning (`.hotkey-help*`) stays scoped. Authored content migrates.",
  },
  {
    path: "src/features/project-detail/cockpit/styles/cockpit.css",
    preserved: true,
    floor: 6,
    note: "Diff slide-over portal positioning (`.plc-diff-*`) + prefers-reduced-motion block stay scoped (catalog residual).",
  },
  {
    path: "src/features/session/sidebar/styles/PeekPopover.css",
    preserved: true,
    floor: 6,
    note: "Tiptap `.ProseMirror` editor DOM + peek backdrop portal positioning + `peek-*` keyframes stay scoped.",
  },
  // ---- Fully-migratable owners (target floor 0) ----
  {
    path: "src/features/_root/styles/index.css",
    preserved: false,
    floor: 0,
    note: "Pure `@import` aggregator — no DOM selectors.",
  },
  {
    path: "src/features/_root/styles/tokens.css",
    preserved: false,
    floor: 0,
    note: "CSS-custom-property token source / Stage-A alias bridge; removed in Stage B token finalization (10.1).",
  },
  {
    path: "src/features/_root/styles/theme.css",
    preserved: false,
    floor: 0,
    note: "Tailwind `@theme` token surface — no DOM selectors.",
  },
  {
    path: "src/features/_root/styles/typography.css",
    preserved: false,
    floor: 0,
    note: "Canonical text recipes migrate to primitives; base element typography reconciles with Preflight (Stage B 10.2).",
  },
  {
    path: "src/features/_root/styles/shell.css",
    preserved: false,
    floor: 0,
    note: "`.app[data-page]` grid template — fully migratable layout.",
  },
  {
    path: "src/features/_root/styles/topbar.css",
    preserved: true,
    floor: 10,
    note: "Shared topbar stylesheet. Desktop Topbar.tsx is utility-first; its `.topbar-status-default/session` wrappers are cross-component descendant ANCHORS for injected session controls (SessionInfoStrip/ConversationList/TddToggle target them via descendant selectors in globals.css/session.css). The `.topbar`/`.topbar-brand`/`.topbar-logo`/`.topbar-divider`/`.topbar-breadcrumb`(+a:hover/.bc-session)/`.topbar-sep` rules are consumed by the Stage-B3 MobileSessionView, which hand-rolls topbar markup with these exact classes (verified: MobileSessionView.stories.tsx; see stage-b2-topbar-followups.md). Not migratable until MobileSessionView migrates (B-3) — corrects the earlier 'fully migratable' note, which did not account for that consumer.",
  },
  {
    path: "src/features/_root/styles/sidebar.css",
    preserved: false,
    floor: 0,
    note: "`.convo-sidebar*` — fully migratable responsive layout.",
  },
  {
    path: "src/features/_root/styles/sidebar-nav.css",
    preserved: false,
    floor: 0,
    note: "Empty reserved placeholder.",
  },
  {
    path: "src/features/_root/styles/session.css",
    preserved: false,
    floor: 0,
    note: "Dense session layout — fully migratable (keyframes reconciled in the token bridge).",
  },
  {
    path: "src/features/_root/styles/conversation-tabs.css",
    preserved: false,
    floor: 0,
    note: "`.conversation-tab*` tab strip — fully migratable.",
  },
  {
    path: "src/features/_root/styles/conversation-panes.css",
    preserved: false,
    floor: 0,
    note: "`.pane*` split-screen layout — fully migratable.",
  },
  {
    path: "src/features/_root/styles/approval-gate.css",
    preserved: false,
    floor: 0,
    note: "`.approval-gate*` — fully migratable.",
  },
  {
    path: "src/features/_root/spawn-card/spawn-card.css",
    preserved: false,
    floor: 0,
    note: "`.spawn-card*` — fully migratable feature layout.",
  },
  {
    path: "src/features/project-detail/styles/project-detail.css",
    preserved: false,
    floor: 0,
    note: "Canonical `.cc-*` recipes + authored layout migrate to primitives (keyframes reconciled in the token bridge).",
  },
  {
    path: "src/features/project-detail/composer/styles/composer.css",
    preserved: false,
    floor: 0,
    note: "`.plc-uc-*` unified composer — fully migratable.",
  },
  {
    path: "src/features/projects-index/styles/projects-index.css",
    preserved: false,
    floor: 0,
    note: "`.project-card*` — Stage-A pilot surface (already migrated; remaining selectors migrate fully).",
  },
  {
    path: "src/features/config/styles/config-editor.css",
    preserved: false,
    floor: 0,
    note: "`.config-*` — fully migratable.",
  },
  {
    path: "src/features/workflows-catalog/styles/workflows-catalog.css",
    preserved: false,
    floor: 0,
    note: "`.workflow-*` catalog + `.mc-*` machine-canvas — fully migratable.",
  },
  {
    path: "src/features/workflows-builder/styles/workflows-builder.css",
    preserved: false,
    floor: 0,
    note: "`.wb-*` authored builder chrome — fully migratable (graph stays bespoke, Stage B 9.1).",
  },
  {
    path: "src/features/session-diff/styles/session-diff.css",
    preserved: false,
    floor: 0,
    note: "`.session-diff-*` full-page diff — fully migratable.",
  },
  {
    path: "src/features/session-workflow/styles/session-workflow.css",
    preserved: false,
    floor: 0,
    note: 'Single `.app[data-page="workflow"] .main` layout rule — fully migratable.',
  },
];

const FLOOR_BY_PATH: ReadonlyMap<string, OwnerFloor> = new Map(
  OWNER_FLOORS.map((o) => [o.path, o]),
);

/**
 * Guard the catalog's core invariant: the `preserved` allowlist flag and a
 * non-zero floor are two views of the same fact — a preserved owner keeps scoped
 * CSS forever (floor > 0); a fully-migratable owner targets zero (floor 0).
 * Returns a list of inconsistencies (empty ⇒ catalog is internally consistent),
 * so a future Stage-B floor edit that desyncs the two is caught loudly.
 */
export function validateFloorCatalog(owners: readonly OwnerFloor[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const owner of owners) {
    if (seen.has(owner.path)) {
      issues.push(`${owner.path}: duplicate catalog entry.`);
    }
    seen.add(owner.path);
    if (owner.preserved && owner.floor <= 0) {
      issues.push(
        `${owner.path}: marked preserved but declares floor ${owner.floor} (must be > 0).`,
      );
    }
    if (!owner.preserved && owner.floor !== 0) {
      issues.push(
        `${owner.path}: not preserved but declares floor ${owner.floor} (must be 0).`,
      );
    }
  }
  return issues;
}

/** True when `node` sits anywhere inside an `@keyframes` block. */
function isInsideKeyframes(node: Container | undefined): boolean {
  let cursor: Container | undefined = node;
  while (cursor) {
    if (
      cursor.type === "atrule" &&
      (cursor as AtRule).name.toLowerCase().endsWith("keyframes")
    ) {
      return true;
    }
    cursor = cursor.parent as Container | undefined;
  }
  return false;
}

/**
 * The migration unit: count DOM-targeting selectors an owner declares.
 *
 * Pure (takes CSS text, returns a number) so the ratchet's behaviour is testable
 * against seeded CSS fixtures without touching disk. Every selector in a style
 * rule counts (a comma list of N selectors = N); each `@keyframes` definition
 * counts once; keyframe step rules and non-selector at-rules do not count.
 */
export function countTrackedSelectors(css: string): number {
  const root = postcss.parse(css);
  let count = 0;

  root.walkRules((rule: Rule) => {
    if (isInsideKeyframes(rule.parent as Container | undefined)) return;
    count += rule.selectors.length;
  });

  root.walkAtRules((atRule: AtRule) => {
    if (atRule.name.toLowerCase().endsWith("keyframes")) count += 1;
  });

  return count;
}

/** Discover every `src/**` CSS file, repo-relative, sorted. */
export function discoverCssFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".css"))
    .map((rel) => path.posix.join("src", rel.split(path.sep).join("/")))
    .sort();
}

export type OwnerState =
  | "ok" // floor ≤ count == baseline (no change)
  | "decreased" // floor ≤ count < baseline (progress)
  | "new" // catalogued owner not yet in the baseline
  | "increase" // count > baseline (regression — FAIL)
  | "below-floor" // count < floor (preserved rule deleted — FAIL)
  | "untracked"; // on disk but absent from OWNER_FLOORS (new debt — FAIL)

export interface OwnerEvalInput {
  readonly path: string;
  readonly liveCount: number;
  /** Recorded high-water count, or null if this owner has no baseline yet. */
  readonly baselineCount: number | null;
  readonly floor: number;
  /** False ⇒ on disk but not in OWNER_FLOORS (untracked owner). */
  readonly inCatalog: boolean;
}

export interface OwnerStatus extends OwnerEvalInput {
  readonly state: OwnerState;
  readonly violation: boolean;
}

export interface RatchetResult {
  readonly ok: boolean;
  readonly statuses: readonly OwnerStatus[];
}

/**
 * Pure ratchet evaluator: classify each owner and decide pass/fail.
 *
 * FAIL conditions (any one trips `ok: false`):
 *  - untracked: a CSS file exists with no `OWNER_FLOORS` entry (new debt).
 *  - increase: live count rose above the recorded baseline (regression).
 *  - below-floor: live count fell below the declared residual floor (a
 *    preserved-forever selector was deleted).
 * A decrease that stays at or above the floor PASSES (migration progress).
 */
export function evaluateRatchet(
  inputs: readonly OwnerEvalInput[],
): RatchetResult {
  const statuses = inputs.map((input): OwnerStatus => {
    if (!input.inCatalog) {
      return { ...input, state: "untracked", violation: true };
    }
    if (input.liveCount < input.floor) {
      return { ...input, state: "below-floor", violation: true };
    }
    if (input.baselineCount === null) {
      return { ...input, state: "new", violation: false };
    }
    if (input.liveCount > input.baselineCount) {
      return { ...input, state: "increase", violation: true };
    }
    if (input.liveCount < input.baselineCount) {
      return { ...input, state: "decreased", violation: false };
    }
    return { ...input, state: "ok", violation: false };
  });

  return { ok: statuses.every((s) => !s.violation), statuses };
}

type Baseline = Record<string, number>;

const baselineSchemaNote =
  "Generated by scripts/css-migration-progress.ts. The owner-level CSS migration " +
  "ratchet high-water mark (selectors+keyframes per owner). Regenerate with " +
  "`bun scripts/css-migration-progress.ts`; do not edit by hand.";

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_JSON)) return null;
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_JSON, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Malformed baseline at ${BASELINE_JSON}`);
  }
  const owners = (parsed as { owners?: unknown }).owners;
  if (owners === null || typeof owners !== "object") {
    throw new Error(`Malformed baseline at ${BASELINE_JSON}: missing owners`);
  }
  const baseline: Baseline = {};
  for (const [key, value] of Object.entries(
    owners as Record<string, unknown>,
  )) {
    if (typeof value !== "number") {
      throw new Error(`Malformed baseline entry for ${key}: not a number`);
    }
    baseline[key] = value;
  }
  return baseline;
}

function writeBaseline(counts: ReadonlyMap<string, number>): void {
  const owners: Baseline = {};
  for (const p of [...counts.keys()].sort()) owners[p] = counts.get(p) ?? 0;
  writeFileSync(
    BASELINE_JSON,
    JSON.stringify({ note: baselineSchemaNote, owners }, null, 2) + "\n",
  );
}

/** Compute the live tracked count for every catalogued + discovered owner. */
function computeLiveCounts(discovered: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  // Every catalogued owner gets a count (0 if its file was deleted by a wave).
  for (const owner of OWNER_FLOORS) counts.set(owner.path, 0);
  for (const rel of discovered) {
    const css = readFileSync(path.join(repoRoot, rel), "utf8");
    counts.set(rel, countTrackedSelectors(css));
  }
  return counts;
}

function buildInputs(
  counts: ReadonlyMap<string, number>,
  baseline: Baseline | null,
): OwnerEvalInput[] {
  const paths = new Set<string>([...counts.keys(), ...FLOOR_BY_PATH.keys()]);
  return [...paths].sort().map((p): OwnerEvalInput => {
    const owner = FLOOR_BY_PATH.get(p);
    return {
      path: p,
      liveCount: counts.get(p) ?? 0,
      baselineCount: baseline ? (baseline[p] ?? null) : null,
      floor: owner?.floor ?? 0,
      inCatalog: owner !== undefined,
    };
  });
}

const STATE_LABEL: Record<OwnerState, string> = {
  ok: "ok",
  decreased: "↓ progress",
  new: "new",
  increase: "✗ INCREASE",
  "below-floor": "✗ BELOW FLOOR",
  untracked: "✗ UNTRACKED",
};

function renderReport(result: RatchetResult): string {
  const rows = [...result.statuses].sort(
    (a, b) => b.liveCount - a.liveCount || a.path.localeCompare(b.path),
  );
  const lines: string[] = [];
  lines.push(
    "Owner-level CSS migration progress (selectors+keyframes per owner)",
  );
  lines.push("");
  lines.push("  count  base  floor  state          owner");
  lines.push("  -----  ----  -----  -------------  -----");
  for (const r of rows) {
    const base = r.baselineCount === null ? "—" : String(r.baselineCount);
    lines.push(
      `  ${String(r.liveCount).padStart(5)}  ${base.padStart(4)}  ${String(r.floor).padStart(5)}  ${STATE_LABEL[r.state].padEnd(13)}  ${r.path}`,
    );
  }
  const total = result.statuses.reduce((n, s) => n + s.liveCount, 0);
  const floorTotal = result.statuses.reduce((n, s) => n + s.floor, 0);
  lines.push("");
  lines.push(
    `  total tracked selectors: ${total} · sum of floors: ${floorTotal} · owners: ${result.statuses.length}`,
  );
  return lines.join("\n");
}

function main(): void {
  const checkMode = process.argv.includes("--check");

  const catalogIssues = validateFloorCatalog(OWNER_FLOORS);
  if (catalogIssues.length > 0) {
    console.error("OWNER_FLOORS catalog is internally inconsistent:");
    for (const issue of catalogIssues) console.error(`  - ${issue}`);
    process.exit(1);
  }

  const discovered = discoverCssFiles();
  const counts = computeLiveCounts(discovered);
  const baseline = loadBaseline();

  if (checkMode && baseline === null) {
    console.error(
      "No CSS migration baseline found. Seed it once with " +
        "`bun scripts/css-migration-progress.ts` and commit " +
        `${path.relative(repoRoot, BASELINE_JSON)}.`,
    );
    process.exit(1);
  }

  const inputs = buildInputs(counts, baseline);
  const result = evaluateRatchet(inputs);

  console.log(renderReport(result));

  const violations = result.statuses.filter((s) => s.violation);
  if (violations.length > 0) {
    console.error("");
    console.error("CSS migration ratchet FAILED:");
    for (const v of violations) {
      if (v.state === "untracked") {
        console.error(
          `  - ${v.path}: untracked CSS owner (${v.liveCount} selectors). ` +
            "Add it to OWNER_FLOORS in scripts/css-migration-progress.ts with a declared floor.",
        );
      } else if (v.state === "increase") {
        console.error(
          `  - ${v.path}: count rose to ${v.liveCount} (baseline ${v.baselineCount}). ` +
            "Migration counts may only decrease.",
        );
      } else {
        console.error(
          `  - ${v.path}: count ${v.liveCount} dropped below its residual floor ${v.floor}. ` +
            "A preserved-forever rule was deleted — restore it or revisit the declared floor.",
        );
      }
    }
    process.exit(1);
  }

  if (checkMode) {
    console.log(
      "\nCSS migration ratchet OK — no owner increased or dropped below its floor.",
    );
    return;
  }

  writeBaseline(counts);
  const lowered = result.statuses.filter((s) => s.state === "decreased").length;
  console.log(
    `\nBaseline written to ${path.relative(repoRoot, BASELINE_JSON)} ` +
      `(${result.statuses.length} owners${lowered > 0 ? `, ${lowered} ratcheted down` : ""}).`,
  );
}

if (import.meta.main) {
  main();
}
