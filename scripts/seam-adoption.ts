#!/usr/bin/env bun
/**
 * Seam-adoption ratchet (consolidated architecture plan §3.5.1 / Phase 0.4),
 * modeled on the CSS migration ratchet (`scripts/css-migration-progress.ts`).
 *
 * Each tracked seam is a place where the codebase currently has TWO ways of
 * solving one problem: a canonical seam plus a population of old-way call
 * sites. The script defines each seam's exact corpus (path predicate over
 * `src/**`), syntax pattern(s), and justified allowlist, counts the old-way
 * population, and enforces the **equal-to-observed rule**: the committed
 * ceiling in `scripts/seam-baselines.json` must EQUAL the observed count.
 *
 *   - observed > ceiling  → FAIL (new old-way debt was introduced)
 *   - observed < ceiling  → FAIL (progress happened; the migration PR must
 *     ratchet the ceiling down explicitly by re-running `--write-baseline`
 *     and committing the diff — so concurrent edits can never silently
 *     loosen a ceiling, and every ratchet movement is a reviewed change)
 *
 * Counts are regex heuristics over file text, not typed program analysis.
 * Each seam documents its unit and its known blind spots inline; the ratchet
 * needs a stable, reviewable number, not a perfect census — audit prose
 * counts are never copied into CI (they were measured with broader corpora).
 *
 * Usage:
 *   bun scripts/seam-adoption.ts                    # report + check (read-only)
 *   bun scripts/seam-adoption.ts --check            # same; the `seams:check` CI gate
 *   bun scripts/seam-adoption.ts --write-baseline   # record observed counts as the
 *                                                   # new ceilings (commit the diff)
 *
 * Wired as the `seams:check` package script (mirroring how the CSS ratchet is
 * wired as `css:progress`), runs as the second half of `bun run lint`, and is
 * invoked by `scripts/pre-merge-validate.sh`.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const srcDir = path.join(repoRoot, "src");
const BASELINE_JSON = path.join(repoRoot, "scripts/seam-baselines.json");

// ---------------------------------------------------------------------------
// Shared source-text helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Extract every module specifier a file imports: static `import … from`,
 * `export … from` re-exports, bare side-effect imports, and dynamic
 * `import("…")`. `vi.mock("…")` is intentionally NOT an import (it is its own
 * seam). Regex-based; a specifier inside a string literal that merely looks
 * like an import clause is a documented blind spot.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const sideEffectRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const re of [fromRe, dynamicRe, sideEffectRe]) {
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      if (spec !== undefined) specifiers.push(spec);
    }
  }
  return specifiers;
}

export type ImportStatementKind =
  | "static"
  | "reexport"
  | "side-effect"
  | "dynamic"
  | "require";

export interface ImportStatement {
  readonly specifier: string;
  readonly kind: ImportStatementKind;
  /** Binding clause between the keyword and `from` ("" when none). */
  readonly clause: string;
  /** True when the statement binds only types (erased at runtime). */
  readonly typeOnly: boolean;
}

/**
 * True when an import/re-export binding clause is fully type-only: a leading
 * `type` keyword (`import type { X }`) or a named clause whose every specifier
 * carries the inline `type` modifier (`import { type X, type Y }`).
 */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type[\s{]/.test(trimmed)) return true;
  const braces = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!braces || braces[1] === undefined) return false;
  const items = braces[1]
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 && items.every((item) => /^type\s/.test(item));
}

/**
 * Classified import-like statements: static imports, `export … from`
 * re-exports, bare side-effect imports, dynamic `import("…")`, and
 * `require("…")` — each with its runtime type-only-ness, so counters can
 * apply the same value-vs-type distinction as the ESLint seam rules.
 * Regex-based, same blind spots as `extractImportSpecifiers`.
 */
export function extractImportStatements(source: string): ImportStatement[] {
  const statements: ImportStatement[] = [];
  const staticRe = /\b(import|export)\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(staticRe)) {
    const [, keyword, clause, specifier] = m;
    if (
      keyword === undefined ||
      clause === undefined ||
      specifier === undefined
    )
      continue;
    statements.push({
      specifier,
      kind: keyword === "export" ? "reexport" : "static",
      clause,
      typeOnly: isTypeOnlyClause(clause),
    });
  }
  const bare: Array<[RegExp, ImportStatementKind]> = [
    [/(?:^|\n)\s*import\s+["']([^"']+)["']/g, "side-effect"],
    [/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, "dynamic"],
    [/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, "require"],
  ];
  for (const [re, kind] of bare) {
    for (const m of source.matchAll(re)) {
      const specifier = m[1];
      if (specifier === undefined) continue;
      statements.push({ specifier, kind, clause: "", typeOnly: false });
    }
  }
  return statements;
}

const isTestPath = (relPath: string): boolean => relPath.includes(".test.");
const isStoriesPath = (relPath: string): boolean =>
  relPath.includes(".stories.");
const isTsSource = (relPath: string): boolean =>
  relPath.endsWith(".ts") || relPath.endsWith(".tsx");

/**
 * Remove line (`//…`) and block (`/* … *\/`) comments so prose that mentions a
 * counted token (e.g. JSDoc describing a primitive) does not inflate a count.
 * A coarse heuristic — it does not track string/regex/template literals, so a
 * `//` sequence inside a string is also dropped; acceptable for the ratchet's
 * attribute-authoring counts, which never live inside string literals.
 */
export function stripJsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------------------
// Per-seam matchers (pure — unit-tested against seeded source fixtures)
// ---------------------------------------------------------------------------

/**
 * Seam 1 unit: VALUE imports (static imports, re-exports, dynamic imports,
 * requires) whose specifier resolves to `events/broadcaster` (the raw SSE
 * transport). Type-only imports (`import type { BroadcastFn }`) are the
 * sanctioned DI seam — the same distinction the `architecture-seams` ESLint
 * rule makes — and count zero. The typed publication layer
 * (`events/publication`) and the rest of the events domain do not match.
 */
export function countBroadcasterValueImports(source: string): number {
  return extractImportStatements(source).filter(
    (stmt) =>
      /(?:^|\/)events\/broadcaster$/.test(stmt.specifier) && !stmt.typeOnly,
  ).length;
}

/**
 * Seam 2 unit: backend-identity comparisons — `===`/`!==` where one operand
 * is an expression whose terminal name contains "backend" (case-insensitive:
 * `backend`, `agentBackend`, `session.backend`, …) and the other is the
 * literal `"claude"` or `"codex"`, in either operand order — plus
 * `case "claude":` / `case "codex":` switch labels. Ternaries branch through
 * `===`/`!==` and are covered by the same match.
 *
 * Heuristic blind spots (documented): `["claude","codex"].includes(x)`,
 * comparisons against a variable holding the literal, and destructured
 * renames that drop "backend" from the identifier are not matched. Object
 * construction (`backend: "claude"`) and non-identity literals
 * (`"claude-skills"`) are correctly not matched.
 */
export function countBackendIdentityBranches(source: string): number {
  const operand = /[\w$]*[Bb]ackend[\w$]*/.source;
  const literal = /["'](?:claude|codex)["']/.source;
  const forward = new RegExp(
    `(?:[\\w$]+\\??\\.)*${operand}\\s*(?:===|!==)\\s*${literal}`,
    "g",
  );
  const reversed = new RegExp(
    `${literal}\\s*(?:===|!==)\\s*(?:[\\w$]+\\??\\.)*${operand}`,
    "g",
  );
  const caseLabel = /\bcase\s+["'](?:claude|codex)["']\s*:/g;
  return (
    (source.match(forward)?.length ?? 0) +
    (source.match(reversed)?.length ?? 0) +
    (source.match(caseLabel)?.length ?? 0)
  );
}

/**
 * Seam 3 unit: import statements reaching below the backend seam — adapter
 * subdirectories (`agent-backends/claude/**`, `agent-backends/codex/**`) or
 * the provider SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`,
 * including subpaths). The seam's neutral surface (`agent-backends/registry`,
 * `agent-backends/types`, …) does not match.
 */
export function countDeepBackendImports(source: string): number {
  return extractImportSpecifiers(source).filter(
    (spec) =>
      /(?:^|\/)agent-backends\/(?:claude|codex)\//.test(spec) ||
      spec === "@anthropic-ai/claude-agent-sdk" ||
      spec.startsWith("@anthropic-ai/claude-agent-sdk/") ||
      spec === "@openai/codex-sdk" ||
      spec.startsWith("@openai/codex-sdk/"),
  ).length;
}

/**
 * Hand-rolled PROJECT-resolution ladders that hide from the literal-404 count.
 *
 * A handler can bypass `resolveProjectOr404` yet leave no `404` literal by
 * awaiting `resolveProjectPath(...)` directly, branching on a null result, and
 * returning the seam's own `notFound(...)` helper — the exact shape that let a
 * voice-handler ladder escape the `status: 404` / trailing-`404` census. This
 * counter closes that gap: it counts each `<var> = await [deps.]resolveProjectPath(...)`
 * assignment whose immediately following `if (!<var>)` / `if (<var> === null)`
 * null-guard returns a `notFound(...)` response — i.e. a project-resolution
 * decision kept local instead of routed through the seam.
 *
 * Deliberately narrow so it does not double-count or false-fire:
 *   - The null branch must return `notFound(...)`. Guards that `throw` (e.g.
 *     `resolveProjectPathOrThrow`) or `return null` (lookup helpers) are not
 *     route-resolution ladders and are excluded.
 *   - Assignments whose guard returns a literal `404` are already counted by
 *     the `status: 404` / trailing-`404` rungs, so they are NOT recounted here.
 *   - `resolveProjectOr404({ resolveProjectPath }, name)` passes the resolver
 *     as a dependency; it is not a direct `await resolveProjectPath(...)` call
 *     and does not match.
 */
export function countHandRolledProjectResolutionLadders(
  source: string,
): number {
  const assignRe =
    /(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+(?:[\w$]+\.)?resolveProjectPath\s*\(/g;
  let count = 0;
  for (const match of source.matchAll(assignRe)) {
    const varName = match[1];
    if (varName === undefined || match.index === undefined) continue;
    // Look only at the window between this assignment and the next statement
    // block that could plausibly hold the guard (bounded, so an unrelated
    // later `notFound(...)` for a different entity does not attach).
    const window = source.slice(match.index, match.index + 400);
    const guardRe = new RegExp(
      `if\\s*\\(\\s*(?:!\\s*${escapeIdentForRegex(varName)}|${escapeIdentForRegex(varName)}\\s*===?\\s*null)\\s*\\)`,
    );
    const guardMatch = guardRe.exec(window);
    if (guardMatch === null) continue;
    const branch = window.slice(guardMatch.index, guardMatch.index + 200);
    if (/\breturn\b[^;]*\bnotFound\s*\(/.test(branch)) count += 1;
  }
  return count;
}

/**
 * Seam 4 unit (heuristic): "rungs" of hand-rolled 404 resolution ladders in
 * route-handler modules. Two shapes count toward one ceiling: (1) each literal
 * 404 used as a response status — `status: 404` property literals, or `404` as
 * a trailing call argument (the `jsonError("…", 404)` idiom, matched across
 * line breaks); and (2) hand-rolled project-resolution ladders that return the
 * seam's `notFound(...)` helper WITHOUT a 404 literal
 * (`countHandRolledProjectResolutionLadders`), the shape that otherwise hides a
 * bypass of `resolveProjectOr404` from the census.
 *
 * Handlers migrated onto the resolve seam (`shared/route-resolution.ts`)
 * return the seam's prebuilt response and contain no 404 literal, so the
 * count measures adoption directly. Blind spots: ladders in non-route-handler
 * helpers (e.g. loaders returning `{ ok: false, status: 404 }`) are outside
 * the corpus; a 404 as a first/only call argument is not matched.
 *
 * Permanent-survivor floor (ceiling = 2, will not reach 0). The resolve seam
 * covers exactly one decision: does the *project* (and, via `resolveSessionRoute`,
 * the *session*) named in the URL exist, returning the flat `{ error, code? }`
 * body. The flat-body DOMAIN-ENTITY not-founds — "Notification not found"
 * (notifications by-id ×2) and "No prepared merge for this session" (git ×1) —
 * now adopt the seam's `notFound(...)` helper (same 404 wire body), so those
 * three rungs are gone.
 *
 * The two remaining rungs both live in
 * `src/lib/agent-capabilities/route-handlers.ts`:
 *   - a missing capability route (`CapabilityRouteNotFoundError`), and
 *   - a missing scoped capability resource (`isScopedResourceNotFoundError`),
 * both emitted through `structuredError("not_found", …, 404)`. That handler's
 * error contract is a NESTED shape — `{ error: { code, message, issues? } }` —
 * which the seam's flat `notFound`/`jsonError` cannot produce without changing
 * the wire. They are genuine domain-entity misses inside an already-resolved
 * project, not project/session resolution (which this file does via its own
 * throw-based `resolveProjectPathOrThrow`, not the shared `resolveProjectOr404`
 * seam). They stay in the corpus rather than the file-excluding allowlist so
 * the ratchet still catches any NEW hand-rolled 404 added to this handler.
 * Deletion condition: this floor drops to 0 only if a future per-entity
 * resolution seam that preserves the nested structured-error shape subsumes
 * these two not-founds; absent that, 2 is the intentional, permanent minimum.
 */
export function countRoute404Rungs(source: string): number {
  const statusProp = /\bstatus:\s*404\b/g;
  const trailingArg = /,\s*404\s*[,)]/g;
  return (
    (source.match(statusProp)?.length ?? 0) +
    (source.match(trailingArg)?.length ?? 0) +
    countHandRolledProjectResolutionLadders(source)
  );
}

/**
 * Site-level classification marker (a JSX attribute) placed ON a `role="dialog"`
 * element that is a SANCTIONED bespoke overlay — a non-modal hover/pin popover
 * or a persistent morphing surface that no current `ui/Dialog`/`ui/Popover`
 * variant can host. A marked site is subtracted from the count; an UNmarked
 * `role="dialog"` added anywhere (including the same file) still counts. This is
 * the per-site exception the plan requires — never whole-file corpus removal,
 * which would blind the ratchet to a newly hand-rolled overlay dropped beside a
 * sanctioned one. Each marked site pairs with an allowlist entry recording its
 * justification and deletion condition.
 */
export const BESPOKE_OVERLAY_JUSTIFIED_ATTR = "data-bespoke-overlay-justified";

/**
 * Bespoke-overlay unit: hand-authored `role="dialog"` / `role="alertdialog"`
 * JSX attributes — an overlay a component wires up itself (its own portal,
 * scrim, focus/Escape/outside-click loop) instead of composing `ui/Dialog`
 * or `ui/Popover`, whose Radix parts own the role and ARIA wiring internally
 * (so the primitives themselves never author the literal attribute and score
 * zero). Both `dialog` and `alertdialog` count. A JSX attribute is
 * `role="dialog"` (or `role={"dialog"}`); a `role: "dialog"` object property
 * (VirtualElement descriptors, config maps) is not a rendered overlay and does
 * not match. Comments (line + block) are stripped first so prose mentioning the
 * attribute (JSDoc describing the primitive) does not inflate the count.
 *
 * A site carrying the `data-bespoke-overlay-justified` marker is a sanctioned
 * survivor (see `BESPOKE_OVERLAY_JUSTIFIED_ATTR`) and is subtracted — the
 * per-site exception, so an unmarked overlay in the same file still counts.
 */
export function countBespokeDialogOverlays(source: string): number {
  const withoutComments = stripJsComments(source);
  const jsxAttr = /\brole=(?:"|'|\{")(?:dialog|alertdialog)(?:"|'|"\})/g;
  const total = withoutComments.match(jsxAttr)?.length ?? 0;
  const justified =
    withoutComments.match(
      new RegExp(`\\b${BESPOKE_OVERLAY_JUSTIFIED_ATTR}\\b`, "g"),
    )?.length ?? 0;
  return total - justified;
}

/** Site-level marker for a reviewed non-status annotation sharing chip geometry. */
export const STATUS_CHIP_JUSTIFIED_ATTR = "data-status-chip-justified";
const STATUS_CHIP_SOURCE_MARKER_PATH =
  "src/components/markdown/Markdown.stories.tsx";
const STATUS_CHIP_SOURCE_MARKER_RE =
  /\bdata-status-chip-justified\s*=\s*(?:"source-line-marker"|'source-line-marker')/;

function countStatusChipClassLiterals(source: string): number {
  const literalRe = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let count = 0;
  for (const match of source.matchAll(literalRe)) {
    const body = match[2];
    if (body === undefined) continue;
    if (
      body.includes("rounded-full") &&
      body.includes("border border-solid") &&
      body.includes("font-mono") &&
      body.includes("text-[0.7rem]")
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Status-chip unit: hand-authored class-string literals that reproduce the
 * `ui/StatusChip` base geometry — the tone-coded status pill's signature is the
 * co-occurrence of `rounded-full` + `border border-solid` + `font-mono` +
 * `text-[0.7rem]` on ONE class literal (double/single-quoted or a template
 * literal). Each such literal outside `ui/StatusChip` is a status pill that has
 * not composed the primitive (plan §1.8 "8+ status-chip implementations → 1").
 *
 * Deliberately narrow to the StatusChip FAMILY, so genuinely-distinct chip
 * primitives do not false-fire: the graph node-status badge
 * (`ExecutionContextNode`, `rounded-[20px]`/uppercase, no `border border-solid`
 * pairing on the base) and the inspector `BackendChip`/`GateChip`
 * (`InspectorChips`, `rounded-sm`/uppercase) use different geometry and never
 * co-locate all four tokens, so they score zero without an allowlist entry.
 * Comments are stripped first so JSDoc mentioning the tokens does not inflate.
 * Blind spot: a status pill assembled by concatenating the tokens across
 * multiple `cn(...)` arguments (no single literal holding all four) is invisible;
 * the population this pins authors the base as one literal, as `ui/StatusChip`
 * did before extraction.
 */
export function countStatusChipPills(source: string, relPath = ""): number {
  const withoutComments = stripJsComments(source);
  const count = countStatusChipClassLiterals(withoutComments);
  if (relPath !== STATUS_CHIP_SOURCE_MARKER_PATH) return count;

  let justified = 0;
  for (const match of withoutComments.matchAll(/<[A-Za-z][^>]*>/g)) {
    const openingTag = match[0];
    if (!STATUS_CHIP_SOURCE_MARKER_RE.test(openingTag)) continue;
    justified += countStatusChipClassLiterals(openingTag);
  }
  return Math.max(0, count - justified);
}

/** Module paths (repo-relative, extensionless) that are infrastructure with
 * module-load-time side effects — the ONLY internal modules `vi.mock` may
 * replace (engineering-principles steering). `@/lib/logging` (module-level
 * `createLogger()` calls) and the sdk-env module (`@/lib/shared/sdk-env`,
 * referred to as `@/lib/sdk-env` in steering). */
const VI_MOCK_INFRA_PREFIXES = ["src/lib/logging", "src/lib/shared/sdk-env"];

function resolveSpecifierToRepoPath(
  spec: string,
  fileRelPath: string,
): string | null {
  if (spec.startsWith("@/")) return path.posix.join("src", spec.slice(2));
  if (spec.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(fileRelPath), spec),
    );
  }
  return null; // external package
}

/**
 * Seam 6 unit: `vi.mock("…")` calls whose specifier is an internal module
 * (`@/…` alias or relative path) outside the infrastructure allowlist.
 * External-package mocks are not internal-module mocks and do not count.
 * The steering-named `@/lib/sdk-env` allowlist entry is honored under both
 * the alias name and its real location (`src/lib/shared/sdk-env`).
 */
export function countInternalViMocks(
  source: string,
  fileRelPath: string,
): number {
  let count = 0;
  for (const match of source.matchAll(/\bvi\.mock\(\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec === undefined) continue;
    if (spec === "@/lib/sdk-env") continue;
    const resolved = resolveSpecifierToRepoPath(spec, fileRelPath);
    if (resolved === null) continue;
    if (VI_MOCK_INFRA_PREFIXES.some((p) => resolved.startsWith(p))) continue;
    count += 1;
  }
  return count;
}

const STATE_STORE_SPEC = /(?:^|\/)state-store(?:\/|$)/;
const STATE_STORE_FACTORY = /^createState(?:Store|Manager)$/;

const escapeIdentForRegex = (name: string): string =>
  name.replace(/\$/g, "\\$");

/**
 * Seam 7 unit: construction CALL expressions of the store factories
 * `createStateStore` / `createStateManager`, bind-aware: only calls of
 * bindings that a value import (or require) actually brings in from the
 * state-store module count, following import aliases
 * (`createStateStore as makeStore` → `makeStore(…)`) and namespace members
 * (`import * as ss` → `ss.createStateStore(…)`). Type-only imports and
 * bindings referenced only in type positions (`ReturnType<typeof …>`) count
 * zero — importing the name is not constructing a store. The sanctioned
 * singleton accessor `getStateStore` does not match. Blind spot: a binding
 * threaded through an intermediate variable before the call is not followed.
 */
export function countStateStoreConstructions(source: string): number {
  const callableBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  for (const stmt of extractImportStatements(source)) {
    if (stmt.kind !== "static") continue;
    if (stmt.typeOnly) continue;
    if (!STATE_STORE_SPEC.test(stmt.specifier)) continue;
    const ns = stmt.clause.match(/\*\s*as\s+([\w$]+)/);
    if (ns?.[1] !== undefined) namespaceBindings.add(ns[1]);
    const braces = stmt.clause.match(/\{([\s\S]*?)\}/);
    if (braces?.[1] !== undefined) {
      for (const raw of braces[1].split(",")) {
        const item = raw.trim();
        if (item === "" || item.startsWith("type ")) continue;
        const named = item.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        const imported = named?.[1];
        if (imported === undefined || !STATE_STORE_FACTORY.test(imported))
          continue;
        callableBindings.add(named?.[2] ?? imported);
      }
    }
  }

  const requireRe =
    /(?:const|let|var)\s+(\{[\s\S]*?\}|[\w$]+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(requireRe)) {
    const binding = m[1];
    const spec = m[2];
    if (binding === undefined || spec === undefined) continue;
    if (!STATE_STORE_SPEC.test(spec)) continue;
    if (binding.startsWith("{")) {
      for (const raw of binding.slice(1, -1).split(",")) {
        const item = raw.trim();
        const destructured = item.match(/^([\w$]+)(?:\s*:\s*([\w$]+))?$/);
        const key = destructured?.[1];
        if (key === undefined || !STATE_STORE_FACTORY.test(key)) continue;
        callableBindings.add(destructured?.[2] ?? key);
      }
    } else {
      namespaceBindings.add(binding);
    }
  }

  let count = 0;
  for (const name of callableBindings) {
    const callRe = new RegExp(
      `(?<![.\\w$])${escapeIdentForRegex(name)}\\s*\\(`,
      "g",
    );
    count += source.match(callRe)?.length ?? 0;
  }
  for (const ns of namespaceBindings) {
    const memberCallRe = new RegExp(
      `(?<![.\\w$])${escapeIdentForRegex(ns)}\\s*\\.\\s*createState(?:Store|Manager)\\s*\\(`,
      "g",
    );
    count += source.match(memberCallRe)?.length ?? 0;
  }
  return count;
}

/**
 * Seam 8 unit (heuristic): hand-written structured-output schemas —
 *   1. `const *_JSON_SCHEMA … = {` / `const *_OUTPUT_SCHEMA … = {`
 *      declarations whose initializer is an object literal, and
 *   2. inline object literals flowing directly into an `outputSchema:` value
 *      or the `schema:` value of an `outputFormat: { … }` object.
 * Constants derived from the canonical generator (`z.toJSONSchema(...)`)
 * initialize with a call, not `{`, and do not match — at declarations or at
 * flow sites. Named-constant flows (`schema: SOME_OUTPUT_SCHEMA`) are counted
 * once at their declaration, not again per flow. Blind spots: a hand-written
 * schema following neither naming convention and never flowing inline is
 * invisible; a `schema:` object literal separated from its `outputFormat: {`
 * by another braced expression is not matched.
 */
export function countStructuredOutputProjections(source: string): number {
  const constDecl = /\bconst\s+[\w$]*_(?:JSON|OUTPUT)_SCHEMA\b[^=\n]*=\s*\{/g;
  const inlineOutputSchema = /\boutputSchema:\s*\{/g;
  const inlineOutputFormatSchema = /\boutputFormat:\s*\{[^{}]*\bschema:\s*\{/g;
  return (
    (source.match(constDecl)?.length ?? 0) +
    (source.match(inlineOutputSchema)?.length ?? 0) +
    (source.match(inlineOutputFormatSchema)?.length ?? 0)
  );
}

/**
 * Seam 9 unit: hardcoded backend ENUMERATION in UI code — sites that bake the
 * closed backend population into presentation instead of rendering from the
 * catalog (`useBackendCatalogQuery` / the catalog module):
 *   1. backend-id pair array literals (`["claude", "codex"]`, either order),
 *   2. backend-id object keys whose value is a string literal — the
 *      label/tone-map shape (`claude: "bg-cyan-glow"`, `"codex": "Codex"`),
 *      bare or quoted, and
 *   3. `Record<AgentBackendId, …>` closed map types.
 *
 * Deliberately NOT matched: object construction placing an id in value
 * position (`backend: "claude"`), ternary arms (`? "codex" : "claude"` — the
 * `(?<!\?\s*)` guard), `case` labels and identity comparisons (those are the
 * backend-identity seam), and per-provider config sub-blocks
 * (`codex: { model: … }` — the value is not a string literal). Blind spot: a
 * backend-keyed map whose values are non-string expressions is invisible to
 * pattern 2.
 */
export function countHardcodedBackendEnumerations(source: string): number {
  const pairArray =
    /\[\s*["'](?:claude|codex)["']\s*,\s*["'](?:claude|codex)["']\s*\]/g;
  const bareStringKey = /(?<![\w$.])(?<!\?\s*)(?:claude|codex)\s*:\s*["']/g;
  const quotedStringKey = /(?<!\?\s*)["'](?:claude|codex)["']\s*:\s*["']/g;
  const recordType = /\bRecord<\s*AgentBackendId\b/g;
  return (
    (source.match(pairArray)?.length ?? 0) +
    (source.match(bareStringKey)?.length ?? 0) +
    (source.match(quotedStringKey)?.length ?? 0) +
    (source.match(recordType)?.length ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Seam catalog
// ---------------------------------------------------------------------------

export interface AllowlistEntry {
  /** Repo-relative path; a trailing `/` means directory-prefix match. */
  readonly path: string;
  /** Why this location is sanctioned rather than counted as debt. */
  readonly justification: string;
  /** A site marker is subtracted by the counter; its file remains in the corpus. */
  readonly siteLevel?: boolean;
}

export interface SeamDefinition {
  readonly id: string;
  readonly title: string;
  /** Exact ceiling whose survivor population and deletion conditions have been reviewed. */
  readonly reviewedCeiling: number;
  /** What one count means (the ratchet's unit). */
  readonly unit: string;
  /** Human-readable corpus description (glob + exclusions). */
  readonly corpus: string;
  readonly allowlist: readonly AllowlistEntry[];
  /** Path predicate over repo-relative paths; applied before counting.
   * Encodes the corpus AND the allowlist exclusions. */
  inCorpus(relPath: string): boolean;
  /** Pure matcher: source text (+ path, for specifier resolution) → count. */
  count(source: string, relPath: string): number;
}

function matchesAllowlist(
  relPath: string,
  allowlist: readonly AllowlistEntry[],
): boolean {
  return allowlist.some(
    (entry) =>
      !entry.siteLevel &&
      (entry.path.endsWith("/")
        ? relPath.startsWith(entry.path)
        : relPath === entry.path),
  );
}

const BACKEND_SEAM_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    path: "src/lib/agent-backends/",
    justification:
      "The backend adapter seam itself — backend identity and provider SDK knowledge live here by design (plan §3.1).",
  },
];

export const SEAMS: readonly SeamDefinition[] = [
  {
    id: "broadcaster-direct-imports",
    title: "Direct events/broadcaster value imports",
    reviewedCeiling: 0,
    unit: "value imports/re-exports/dynamic imports/requires of events/broadcaster (type-only imports are the DI seam and count zero)",
    corpus:
      "src/**/*.{ts,tsx} minus tests/stories; excludes src/lib/events/ (the SSE publication/transport layer that owns the broadcaster and the typed publication module).",
    allowlist: [
      {
        path: "src/lib/events/",
        justification:
          "The SSE publication/transport domain — broadcaster's home; publication.ts is the sanctioned publication path (plan §3.4).",
      },
    ],
    inCorpus(relPath) {
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        !isStoriesPath(relPath) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source) => countBroadcasterValueImports(source),
  },
  {
    id: "backend-identity-branches",
    title: "Backend-identity branches outside the adapter seam",
    reviewedCeiling: 25,
    unit: 'backend ===/!== "claude"|"codex" comparisons + case labels',
    corpus:
      "src/**/*.{ts,tsx} minus tests/stories (fixture/prototype code is not the migration population); excludes src/lib/agent-backends/. Permanent-survivor floor (ceiling > 0, not expected to reach 0): per P3 the surviving branches are sanctioned adapter-boundary and explicitly-named product-policy sites — the places where the {claude, codex} pair IS the decision, not a defect to route through a normalized adapter result. These are (a) the curated collaboration pair (D19: the Claude×Codex pairing is the feature; identity is intrinsic), (b) presentation/label and default-selection maps keyed by the two ids where a normalized capability field would add no behavior, and (c) the narrow disposition/continuation reads the descriptor classifier has not yet subsumed. Deletion condition (drops per site as each is reached): a branch leaves the floor only when its distinction is expressed as a declared capability field or a normalized result field (e.g. continuationDisposition) per P3, or when the descriptor's failure/continuation classifier subsumes it (§3.1.5/1.5). The floor reaches 0 only if every remaining site becomes such a data-driven read; absent that, the reviewed nonzero count is the intentional adapter-boundary/product-policy minimum, ratcheted down whenever a migration removes an identity check. Stays in the corpus (not a file-excluding allowlist) so any NEW identity branch added above the seam still fails the ratchet.",
    allowlist: BACKEND_SEAM_ALLOWLIST,
    inCorpus(relPath) {
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        !isStoriesPath(relPath) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source) => countBackendIdentityBranches(source),
  },
  {
    id: "backend-deep-imports",
    title: "Deep adapter/SDK imports outside the backend seam",
    reviewedCeiling: 1,
    unit: "imports of agent-backends/{claude,codex}/** or provider SDKs",
    corpus:
      "src/**/*.{ts,tsx} INCLUDING tests and stories (the import boundary applies everywhere — adapter tests live inside the seam); excludes src/lib/agent-backends/. Shrinking-allowlist survivor floor (ceiling > 0 while any deep importer remains outside the seam; target 0): per P4 provider SDK types and adapter-subdir knowledge must point only downward into an adapter, so every deep import above the seam is debt to relocate behind agent-backends/. The Phase 1 exit criterion permits only an EXPLICIT SHRINKING ALLOWLIST of such imports (§Phase 1 exit / plan line 447): each surviving site is a not-yet-migrated caller whose provider knowledge belongs in a backend facet. Deletion condition (per site): the import drops to 0 when the caller moves its provider-specific work behind the neutral backend seam (descriptor/adapter operation or continuity adapter, Phase 1.3/1.6) so it imports only the seam's neutral surface. The floor reaches 0 when the last such caller is migrated; until then the reviewed count is the explicit shrinking allowlist, ratcheted down with each migration. Stays in the corpus (not a file-excluding allowlist) so any NEW deep adapter/SDK import outside the seam still fails the ratchet.",
    allowlist: BACKEND_SEAM_ALLOWLIST,
    inCorpus(relPath) {
      return isTsSource(relPath) && !matchesAllowlist(relPath, this.allowlist);
    },
    count: (source) => countDeepBackendImports(source),
  },
  {
    id: "route-404-ladders",
    title: "Hand-rolled route 404 ladders",
    reviewedCeiling: 2,
    unit: "404-response rungs (status: 404 literals + trailing-arg 404s + awaited-resolveProjectPath null->notFound ladders)",
    corpus:
      "src/**/*route-handlers*.ts(x) plus response-producing src/**/*-handler.ts(x) modules, minus tests — the route-handler module convention (structure.md) plus its extracted response helpers. Non-route *-handler helpers are excluded by the justified allowlist; domain route-resolution.ts composition modules and shared/route-resolution.ts are outside the corpus by name. The ceiling of 2 is a permanent survivor floor — two DOMAIN-ENTITY not-founds in agent-capabilities/route-handlers.ts (missing capability route + missing scoped resource) whose NESTED structured-error body ({ error: { code, message } }) the flat resolve seam cannot produce; see the countRoute404Rungs doc-comment for the per-site reasoning and deletion condition. This file stays in the corpus rather than the file-excluding allowlist so the ratchet still catches any new hand-rolled 404 added to it.",
    allowlist: [
      {
        path: "src/features/session/panes/pane-fork-handler.ts",
        justification:
          "Client-side pane-interaction handler — produces no HTTP responses, so it is not part of the route-404 population.",
      },
      {
        path: "src/lib/workflows/conversation/external-turn-handler.ts",
        justification:
          "Workflow-internal external-turn processing helper — produces no HTTP responses.",
      },
    ],
    inCorpus(relPath) {
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        (relPath.includes("route-handlers") ||
          /-handler\.tsx?$/.test(relPath)) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source) => countRoute404Rungs(source),
  },
  // The `data-tooltip` seam is RETIRED (plan §3.5.1 deletion test; Phase 5
  // review finding 2): all authoring sites migrated to WithTooltip / ui/Tooltip,
  // the delegated TooltipProvider is deleted, and the population is now held at
  // zero BY CONSTRUCTION — the `architecture-seams/no-data-tooltip-attribute`
  // ESLint rule rejects any new `data-tooltip` JSX attribute, so a ratchet seam
  // would be redundant. It has no baseline entry and no catalog row.
  {
    id: "bespoke-dialog-overlays",
    title: "Hand-rolled role=dialog overlays (pre-ui/Dialog variant)",
    reviewedCeiling: 0,
    unit: 'role="dialog"/"alertdialog" JSX attributes authored outside ui/Dialog+ui/Popover, minus data-bespoke-overlay-justified sites',
    corpus:
      "src/**/*.tsx minus tests. Stories ARE included (they render the markup and migrate with their component). The ui/Dialog + ui/Popover primitives compose Radix parts that own the role internally, so they never author the literal attribute and are not in the population. EVERY file stays IN the corpus — there is no file-excluding allowlist, so a newly hand-rolled overlay added beside a sanctioned survivor still counts. The two permanent survivors below carry the `data-bespoke-overlay-justified` marker (subtracted per-site by countBespokeDialogOverlays); the ceiling of 0 is the marked-adjusted count. The migrated MobilePromptToolbar sheets now compose ui/Dialog, and DevServerDrawer's inline conflict card is role=alert (a live region, not an overlay), so neither authors a counted role=dialog.",
    allowlist: [
      {
        path: "src/features/session/conversation/InfoDetailsPopover.tsx",
        siteLevel: true,
        justification:
          "SITE-level survivor (marked data-bespoke-overlay-justified, not a whole-file exclusion): a hover-peek + click-pin NON-MODAL popover (no focus trap/scrim by design) driven by a bespoke hover-intent state machine, not Radix's click/focus open model. Deletion condition: a hover-intent Popover trigger variant on ui/Popover — until it exists, migrating would drop the hover-peek affordance.",
      },
      {
        path: "src/components/AskQuestionPanel.tsx",
        siteLevel: true,
        justification:
          "SITE-level survivor (marked data-bespoke-overlay-justified, not a whole-file exclusion): a dual-mode banner/max morph — one role=dialog element persists as an inline non-modal banner and morphs (CSS height transition) into the maximized sheet, so it is never a discretely-mounted overlay a portaled Dialog can host. Deletion condition: a persistent morphing-surface Dialog variant that preserves the in-place banner→sheet morph while owning Radix focus containment.",
      },
    ],
    // No whole-file removal: every .tsx source stays in the corpus so a NEW
    // hand-rolled overlay is always counted. Sanctioned survivors are excluded
    // per-SITE via the data-bespoke-overlay-justified marker (subtracted by the
    // counter), not by dropping their file from the corpus.
    inCorpus(relPath) {
      return relPath.endsWith(".tsx") && !isTestPath(relPath);
    },
    count: (source) => countBespokeDialogOverlays(source),
  },
  {
    id: "status-chip-pills",
    title: "Hand-authored status pills (pre-ui/StatusChip)",
    reviewedCeiling: 7,
    unit: "class literals co-locating rounded-full + border border-solid + font-mono + text-[0.7rem] (the ui/StatusChip base geometry) outside the primitive, minus data-status-chip-justified sites",
    corpus:
      "src/**/*.{ts,tsx} minus tests. Stories ARE included (they render the markup and migrate with their component). Excludes ui/StatusChip.tsx (the primitive that owns the base geometry). The tone-coded status pills the audit counted (§1.8 '8+ status-chip implementations → 1') have adopted the primitive; the ceiling of 7 is a permanent-survivor floor of genuinely-DISTINCT chip primitives that happen to share the four base tokens but are not tone-coded status pills: the interactive MCP info button (McpInfoChip, data-[overrides] hover-morph + count badge), the branch selector (BranchChip, max-width + copy affordance), the topbar needs-attention nav anchor (Topbar), the aria-pressed filter toggle (ConversationAutocompleteList), the blue interactive plugin link (AgentCapabilityPanel's PLUGIN_CHIP), and the two uppercase override-count badges (ConfigField, ConfigSubsection). The graph node-status badge (ExecutionContextNode) and inspector BackendChip/GateChip (InspectorChips) use different geometry (rounded-[20px]/rounded-sm, uppercase) and never co-locate all four tokens, so they are outside the population without an entry. Markdown.stories.tsx's numbered source-map overlay is a site-level non-status annotation carrying data-status-chip-justified; its file remains in the corpus, and the counter subtracts only that marked site. Its deletion condition is a dedicated numbered-marker primitive for source-map overlays. All survivors stay IN the corpus rather than creating a file blind spot, so the ratchet still catches any NEW hand-rolled status pill that should compose the primitive. The seven-count floor drops only if one of the distinct chip primitives is folded onto a future StatusChip shape/tone variant.",
    allowlist: [
      {
        path: "src/components/ui/StatusChip.tsx",
        justification:
          "The primitive that owns the status-pill base geometry — its base literal is the canonical definition, not a hand-rolled copy (plan §1.8).",
      },
      {
        path: STATUS_CHIP_SOURCE_MARKER_PATH,
        siteLevel: true,
        justification:
          "The marked source-line overlay is a numbered source-location annotation, not a status. Its file remains in the corpus and only the data-status-chip-justified site is subtracted. Deletion condition: adopt a dedicated numbered-marker primitive for source-map overlays.",
      },
    ],
    inCorpus(relPath) {
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source, relPath) => countStatusChipPills(source, relPath),
  },
  {
    id: "internal-vi-mocks",
    title: "Internal non-infrastructure vi.mock calls",
    reviewedCeiling: 68,
    unit: "vi.mock calls on internal modules outside the infra allowlist",
    corpus:
      "src/**/*.test.{ts,tsx}. Infrastructure allowlist (steering): @/lib/logging and the sdk-env module (@/lib/sdk-env, located at src/lib/shared/sdk-env). External-package mocks do not count. Migration-only survivor floor (ceiling > 0 while unmigrated tests remain; target 0): per D20 the ~100+ internal vi.mock sites are not sloppiness but the signal of a MISSING client-test seam — engineering-principles forbids mocking internal modules, and the sanctioned replacement is fetch-level fakes + an injectable query client (installFetchFixture / renderWithQuery). Every surviving count is migration-only debt: a test still replacing an internal module instead of running the real hook/store over the fetch fixture. Deletion condition (per test file): a mock drops when its test is rewritten onto the sanctioned client-test seam (D20) — real React Query, real fetcher validation, real Zod schemas, real Zustand store — faking only the network boundary. The floor reaches 0 (and the seam retires) when the last non-infrastructure vi.mock is migrated; until then the reviewed count is the migration-only backlog, ratcheted down as each test moves. The allowlist is empty by design: only the two module-load-time infrastructure prefixes (encoded in VI_MOCK_INFRA_PREFIXES) are ever exempt, so any NEW internal vi.mock still fails the ratchet.",
    allowlist: [],
    inCorpus(relPath) {
      return isTsSource(relPath) && isTestPath(relPath);
    },
    count: (source, relPath) => countInternalViMocks(source, relPath),
  },
  {
    id: "state-store-construction",
    title: "createStateStore/createStateManager outside state-store",
    reviewedCeiling: 0,
    unit: "construction call expressions of factory bindings imported from the state-store module (aliases and namespace members followed; type-only/type-position imports count zero)",
    corpus:
      "src/**/*.{ts,tsx} minus tests; excludes src/lib/state-store/ (the owning domain) and src/lib/shared/testing/ (the sanctioned real-store persistence fixture).",
    allowlist: [
      {
        path: "src/lib/state-store/",
        justification:
          "The store's owning domain — construction is legal here by definition.",
      },
      {
        path: "src/lib/shared/testing/",
        justification:
          "The sanctioned persistence fixture constructs a real store over :memory: DBs for contract tests (persistence-testing steering).",
      },
    ],
    inCorpus(relPath) {
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source) => countStateStoreConstructions(source),
  },
  {
    id: "structured-output-schema-literals",
    title: "Hand-written structured-output schemas",
    reviewedCeiling: 25,
    unit: "const *_JSON_SCHEMA/*_OUTPUT_SCHEMA = { … } declarations + inline object literals flowing into outputSchema / outputFormat.schema",
    corpus:
      "src/**/*.{ts,tsx} minus tests; excludes src/lib/shared/testing/ (fixture modules the `.test.` filename filter misses). Constants and flows fed by the canonical generator (z.toJSONSchema) do not match the pattern. Both backend adapters accept the caller's complete schema, so provider compatibility is not a reason to duplicate or weaken a Zod-owned contract. Two populations share this count: (1) duplicate schema knowledge that should move to the canonical generator, and (2) independently authored neutral JSON Schema contracts that may remain when no Zod schema owns their interface. Deletion condition (per site): a literal drops when it restates a Zod contract the canonical generator can supply without changing behavior. The allowlist covers only test-fixture directories, so any new hand-written schema literal in production code still fails the ratchet until the reviewed ceiling is intentionally updated.",
    allowlist: [
      {
        path: "src/lib/shared/testing/",
        justification:
          "Test-only fixture modules (never imported by production code). A maximal round-trip fixture must carry a distinctive value for the per-context `outputSchema` field — an opaque author-supplied JSON Schema document with no Zod contract behind it, so the canonical generator can never supply it. Deletion condition: this entry drops if the fixture directory stops needing a literal output-schema document.",
      },
    ],
    inCorpus(relPath) {
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source) => countStructuredOutputProjections(source),
  },
  {
    id: "hardcoded-backend-enumeration",
    title: "Hardcoded backend enumeration in UI code",
    reviewedCeiling: 0,
    unit: '["claude","codex"] pair arrays + backend-id label/tone map keys (string-literal values) + Record<AgentBackendId, …> map types',
    corpus:
      "UI code only (src/app, src/components, src/features, src/hooks, src/stores) minus tests/stories — the population that must render backends from the catalog (useBackendCatalogQuery / the catalog module). Non-UI domain code is covered by the backend-identity seam. Per-provider config sub-blocks (`codex: { model: … }`) never match the unit, so genuinely provider-specific config fields need no allowlist entries.",
    allowlist: [
      {
        path: "src/features/session/conversation/collab/",
        justification:
          "Collaboration's explicit two-agent pair configuration is exempt by design decision D19 — the Claude/Codex pair IS the feature, not an enumeration to migrate.",
      },
    ],
    inCorpus(relPath) {
      const uiRoots = [
        "src/app/",
        "src/components/",
        "src/features/",
        "src/hooks/",
        "src/stores/",
      ];
      return (
        isTsSource(relPath) &&
        !isTestPath(relPath) &&
        !isStoriesPath(relPath) &&
        uiRoots.some((root) => relPath.startsWith(root)) &&
        !matchesAllowlist(relPath, this.allowlist)
      );
    },
    count: (source) => countHardcodedBackendEnumerations(source),
  },
];

/**
 * Catalog self-check: duplicate seam ids, duplicate allowlist paths, and
 * allowlist entries whose path no longer exists on disk (stale justification)
 * all fail loudly. Returns issues (empty ⇒ consistent).
 */
export function validateSeamCatalog(
  seams: readonly SeamDefinition[],
  pathExists: (relPath: string) => boolean = (rel) =>
    existsSync(path.join(repoRoot, rel)),
): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  for (const seam of seams) {
    if (seenIds.has(seam.id)) issues.push(`${seam.id}: duplicate seam id.`);
    seenIds.add(seam.id);
    const seenPaths = new Set<string>();
    for (const entry of seam.allowlist) {
      if (seenPaths.has(entry.path)) {
        issues.push(`${seam.id}: duplicate allowlist entry ${entry.path}.`);
      }
      seenPaths.add(entry.path);
      const probe = entry.path.endsWith("/")
        ? entry.path.slice(0, -1)
        : entry.path;
      if (!pathExists(probe)) {
        issues.push(
          `${seam.id}: allowlist path ${entry.path} does not exist (stale entry).`,
        );
      }
    }
  }
  return issues;
}

export interface ReviewedSeamCeiling {
  readonly id: string;
  readonly reviewedCeiling: number;
}

/**
 * Keeps the generated baseline subordinate to the reviewed catalog. Baseline
 * generation may record an observed population, but it cannot approve a new
 * survivor floor by itself.
 */
export function validateReviewedSeamCeilings(
  seams: readonly ReviewedSeamCeiling[],
  generatedCeilings: Readonly<Record<string, number>>,
): string[] {
  const issues: string[] = [];
  for (const seam of seams) {
    const generatedCeiling = generatedCeilings[seam.id];
    if (generatedCeiling === undefined) continue;
    if (generatedCeiling === seam.reviewedCeiling) continue;
    issues.push(
      `${seam.id}: generated ceiling ${generatedCeiling} does not match reviewed ceiling ${seam.reviewedCeiling}.`,
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Ratchet evaluation (pure)
// ---------------------------------------------------------------------------

export type SeamState =
  | "ok" // observed == ceiling
  | "above-ceiling" // new old-way debt (FAIL)
  | "below-ceiling" // progress not ratcheted — ceiling must equal observed (FAIL)
  | "unseeded" // seam missing from the baseline (FAIL)
  | "stale-baseline"; // baseline entry with no matching seam (FAIL)

export interface SeamEvalInput {
  readonly id: string;
  readonly observed: number;
  /** Committed ceiling, or null when the baseline has no entry. */
  readonly ceiling: number | null;
}

export interface SeamStatus {
  readonly id: string;
  readonly observed: number;
  readonly ceiling: number | null;
  readonly state: SeamState;
  readonly violation: boolean;
}

export interface SeamRatchetResult {
  readonly ok: boolean;
  readonly statuses: readonly SeamStatus[];
}

/**
 * The equal-to-observed rule: any inequality between observed and ceiling is
 * a failure — above means regression, below means an un-ratcheted migration.
 * Baseline entries with no live seam are stale and also fail.
 */
export function evaluateSeamRatchet(
  inputs: readonly SeamEvalInput[],
  baselineIds: readonly string[] = inputs.map((i) => i.id),
): SeamRatchetResult {
  const liveIds = new Set(inputs.map((i) => i.id));
  const statuses: SeamStatus[] = inputs.map((input) => {
    if (input.ceiling === null) {
      return { ...input, state: "unseeded", violation: true };
    }
    if (input.observed > input.ceiling) {
      return { ...input, state: "above-ceiling", violation: true };
    }
    if (input.observed < input.ceiling) {
      return { ...input, state: "below-ceiling", violation: true };
    }
    return { ...input, state: "ok", violation: false };
  });
  for (const id of baselineIds) {
    if (!liveIds.has(id)) {
      statuses.push({
        id,
        observed: 0,
        ceiling: null,
        state: "stale-baseline",
        violation: true,
      });
    }
  }
  return { ok: statuses.every((s) => !s.violation), statuses };
}

// ---------------------------------------------------------------------------
// Disk I/O + CLI
// ---------------------------------------------------------------------------

interface SeamObservation {
  readonly seam: SeamDefinition;
  readonly total: number;
  /** Per-file counts (only files with hits), for offender reporting. */
  readonly perFile: ReadonlyMap<string, number>;
}

function discoverSourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .map((rel) => path.posix.join("src", rel.split(path.sep).join("/")))
    .filter(isTsSource)
    .sort();
}

function observeSeams(files: readonly string[]): SeamObservation[] {
  const contentByPath = new Map<string, string>();
  const contentOf = (rel: string): string => {
    const cached = contentByPath.get(rel);
    if (cached !== undefined) return cached;
    const text = readFileSync(path.join(repoRoot, rel), "utf8");
    contentByPath.set(rel, text);
    return text;
  };

  return SEAMS.map((seam) => {
    const perFile = new Map<string, number>();
    let total = 0;
    for (const rel of files) {
      if (!seam.inCorpus(rel)) continue;
      const n = seam.count(contentOf(rel), rel);
      if (n > 0) {
        perFile.set(rel, n);
        total += n;
      }
    }
    return { seam, total, perFile };
  });
}

type Baseline = Record<string, number>;

const baselineNote =
  "Generated by scripts/seam-adoption.ts (--write-baseline). Per-seam ceilings " +
  "for the seam-adoption ratchet (plan §3.5.1): `bun run seams:check` fails when " +
  "an observed count differs from its ceiling in EITHER direction, so migrations " +
  "must ratchet ceilings down explicitly by regenerating this file. Generation " +
  "is refused unless every count matches its reviewedCeiling in the seam catalog. " +
  "Do not edit by hand.";

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_JSON)) return null;
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_JSON, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Malformed baseline at ${BASELINE_JSON}`);
  }
  const seams = (parsed as { seams?: unknown }).seams;
  if (seams === null || typeof seams !== "object") {
    throw new Error(`Malformed baseline at ${BASELINE_JSON}: missing seams`);
  }
  const baseline: Baseline = {};
  for (const [key, value] of Object.entries(seams as Record<string, unknown>)) {
    if (typeof value !== "number") {
      throw new Error(`Malformed baseline entry for ${key}: not a number`);
    }
    baseline[key] = value;
  }
  return baseline;
}

function writeBaseline(observations: readonly SeamObservation[]): void {
  const seams: Baseline = {};
  for (const obs of [...observations].sort((a, b) =>
    a.seam.id.localeCompare(b.seam.id),
  )) {
    seams[obs.seam.id] = obs.total;
  }
  writeFileSync(
    BASELINE_JSON,
    JSON.stringify({ note: baselineNote, seams }, null, 2) + "\n",
  );
}

const STATE_LABEL: Record<SeamState, string> = {
  ok: "ok",
  "above-ceiling": "✗ ABOVE CEILING",
  "below-ceiling": "✗ RATCHET DOWN",
  unseeded: "✗ UNSEEDED",
  "stale-baseline": "✗ STALE ENTRY",
};

function renderReport(
  result: SeamRatchetResult,
  observations: readonly SeamObservation[],
): string {
  const obsById = new Map(observations.map((o) => [o.seam.id, o]));
  const lines: string[] = [];
  lines.push("Seam-adoption ratchet (old-way population per tracked seam)");
  lines.push("");
  lines.push("  observed  ceiling  state            seam");
  lines.push("  --------  -------  ---------------  ----");
  for (const s of result.statuses) {
    const ceiling = s.ceiling === null ? "—" : String(s.ceiling);
    lines.push(
      `  ${String(s.observed).padStart(8)}  ${ceiling.padStart(7)}  ${STATE_LABEL[s.state].padEnd(15)}  ${s.id}`,
    );
  }
  for (const s of result.statuses) {
    if (!s.violation || s.state === "stale-baseline") continue;
    const obs = obsById.get(s.id);
    if (!obs || obs.perFile.size === 0) continue;
    lines.push("");
    lines.push(`  ${s.id} — ${obs.seam.title}`);
    lines.push(`    unit: ${obs.seam.unit}`);
    const entries = [...obs.perFile.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (const [file, n] of entries) {
      lines.push(`    ${String(n).padStart(4)}  ${file}`);
    }
  }
  return lines.join("\n");
}

function main(): void {
  const writeMode = process.argv.includes("--write-baseline");

  const catalogIssues = validateSeamCatalog(SEAMS);
  if (catalogIssues.length > 0) {
    console.error("SEAMS catalog is internally inconsistent:");
    for (const issue of catalogIssues) console.error(`  - ${issue}`);
    process.exit(1);
  }

  const files = discoverSourceFiles();
  const observations = observeSeams(files);

  if (writeMode) {
    const observedCeilings = Object.fromEntries(
      observations.map((observation) => [
        observation.seam.id,
        observation.total,
      ]),
    );
    const reviewIssues = validateReviewedSeamCeilings(SEAMS, observedCeilings);
    if (reviewIssues.length > 0) {
      console.error(
        "Refusing to write unreviewed seam ceilings. Update the catalog only after each survivor has an approved rationale and deletion condition:",
      );
      for (const issue of reviewIssues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    writeBaseline(observations);
    const result = evaluateSeamRatchet(
      observations.map((o) => ({
        id: o.seam.id,
        observed: o.total,
        ceiling: o.total,
      })),
    );
    console.log(renderReport(result, observations));
    console.log(
      `\nBaseline written to ${path.relative(repoRoot, BASELINE_JSON)} ` +
        `(${observations.length} seams; ceilings set to observed counts). Commit the diff.`,
    );
    return;
  }

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error(
      "No seam baseline found. Seed it once with " +
        "`bun scripts/seam-adoption.ts --write-baseline` and commit " +
        `${path.relative(repoRoot, BASELINE_JSON)}.`,
    );
    process.exit(1);
  }

  const reviewIssues = validateReviewedSeamCeilings(SEAMS, baseline);
  if (reviewIssues.length > 0) {
    console.error(
      "Committed seam ceilings disagree with the reviewed catalog:",
    );
    for (const issue of reviewIssues) console.error(`  - ${issue}`);
    process.exit(1);
  }

  const inputs: SeamEvalInput[] = observations.map((o) => ({
    id: o.seam.id,
    observed: o.total,
    ceiling: baseline[o.seam.id] ?? null,
  }));
  const result = evaluateSeamRatchet(inputs, Object.keys(baseline));

  console.log(renderReport(result, observations));

  const violations = result.statuses.filter((s) => s.violation);
  if (violations.length > 0) {
    console.error("");
    console.error("Seam-adoption ratchet FAILED:");
    for (const v of violations) {
      if (v.state === "above-ceiling") {
        console.error(
          `  - ${v.id}: observed ${v.observed} > ceiling ${v.ceiling}. ` +
            "New old-way debt was introduced — use the canonical seam instead, " +
            "or (for an intentional policy site) add a justified allowlist entry in scripts/seam-adoption.ts.",
        );
      } else if (v.state === "below-ceiling") {
        console.error(
          `  - ${v.id}: observed ${v.observed} < ceiling ${v.ceiling}. ` +
            "Progress must be ratcheted explicitly: run " +
            "`bun scripts/seam-adoption.ts --write-baseline` and commit the baseline diff.",
        );
      } else if (v.state === "unseeded") {
        console.error(
          `  - ${v.id}: no committed ceiling. Regenerate the baseline with --write-baseline.`,
        );
      } else {
        console.error(
          `  - ${v.id}: baseline entry has no matching seam definition. ` +
            "Regenerate the baseline with --write-baseline.",
        );
      }
    }
    process.exit(1);
  }

  console.log(
    "\nSeam-adoption ratchet OK — every observed count equals its committed ceiling.",
  );
}

if (import.meta.main) {
  main();
}
