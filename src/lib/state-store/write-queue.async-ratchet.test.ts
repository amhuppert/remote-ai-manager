/**
 * Shrink-only ratchet on the async `withWriteQueue` entry point.
 *
 * Design 3.3 moves the queue's default reach to `withWriteQueueSync`, whose
 * `() => T` callback makes "await external work while holding the global lock" a
 * compile error. The async `withWriteQueue` survives only for callers whose
 * awaits are queue-internal *by design* — the async Immer mutators that
 * `mutateConversation` runs, where the await resolves an in-memory reducer and
 * never escapes the critical section to I/O, LLM, git, or network.
 *
 * That exception is legitimate but must not spread. This ratchet counts every
 * async call site across `src/lib` and fails when the count grows above the
 * recorded baseline, so a new mutation path can't quietly reach for the async
 * form instead of the sync one. It is shrink-only: migrating a caller to
 * `withWriteQueueSync` lowers the count and keeps passing; nothing forces the
 * baseline down, but nothing lets it rise. Lower BASELINE as callers migrate.
 *
 * The count is AST-based, not a text match, so it is robust to the call forms a
 * regex misses: explicit type arguments (`withWriteQueue<T>(…)`), property-access
 * callees (`writeQueue.withWriteQueue(…)`), optional chaining, arbitrary
 * whitespace/newlines before the parenthesis, and `.tsx` files.
 *
 * A syntactic AST walk can count a *direct* call — `withWriteQueue(…)` or
 * `q.withWriteQueue(…)` — but cannot follow an indirection to its eventual call.
 * So every indirection that could hide an uncounted call is rejected outright:
 * calling a renamed import/destructure alias, reaching the entry by string index
 * (`q["withWriteQueue"]`), aliasing the method or the imported identifier to a
 * value, or renaming it on re-export all FAIL the ratchet. The ONE exception is
 * the composition seam the store is built from: referencing the entry as the
 * value of an object property that is itself named `withWriteQueue` (DI wiring,
 * e.g. `{ withWriteQueue }` or `{ withWriteQueue: shared }`). That preserves the
 * name, so every call made through the resulting `WriteQueue` object is a
 * counted `obj.withWriteQueue(…)` — the value reference hides nothing. With those
 * rules, the only way to *invoke* the async entry is a direct call the counter
 * sees, so the count is a true upper bound a new caller cannot slip past.
 *
 * A symbol-aware `ts.Program` would resolve all of this for free, and was
 * verified to yield the same count as this AST walk, but building a full
 * type-checked program over `src/lib` costs ~25s — too heavy for a unit
 * ratchet. The `scanSource`
 * fixtures below enumerate each call and smuggling form and prove it is counted,
 * rejected, or (for name-preserving DI) allowed.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives in src/lib/state-store; its parent is the src/lib root.
const LIB_ROOT = path.resolve(dirname, "..");
// The queue's own module defines and re-exports the async entry; it is plumbing,
// not a caller, so it never counts against the budget.
const QUEUE_MODULE = path.join(dirname, "write-queue.ts");

const ASYNC_ENTRY = "withWriteQueue";

// Recorded 2026-07-20 (Design 3.3 / Phase 0). Async awaits are allowed only
// when queue-internal by design (see file header). Lower this as callers
// migrate to withWriteQueueSync; never raise it.
// 57 → 56: the graph-workflow execution seam (`mutateActiveGraphWorkflowExecution`)
// adopted `withWriteQueueSync` once its reducer became synchronous (Design 3.1/3.3).
// 56 → 55: `mcp/config-mutation-service.ts` `patchGlobal` stopped holding the
// state-store queue across global-config file I/O — it now fences inside the
// scoped-config file store's own serialized write lock (Design 3, sibling of the
// patchProject/Session/Conversation migration).
// 55 → 54: the spec draft-citation writes (`replaceAssumptionDraftCitations`,
// `mutateDraftCitation`) adopted `withWriteQueueSync` — both wrap a synchronous
// `db.transaction(...).immediate(...)`, like their `recordExternalDelivery`
// sibling, so nothing awaits inside the critical section.
const BASELINE = 54;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(full);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      return [];
    }
    if (full === QUEUE_MODULE) return [];
    return [full];
  });
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Is `node` the exact async entry `withWriteQueue` invoked *directly*, i.e. as a
 * plain identifier callee or a property-access callee (`q.withWriteQueue`)?
 * These are the only two forms the counter attributes to a call; every other
 * reach for the entry is rejected as an indirection.
 */
function isAsyncEntryCallee(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === ASYNC_ENTRY;
  if (ts.isPropertyAccessExpression(node))
    return node.name.text === ASYNC_ENTRY;
  return false;
}

/** Text of a `propertyName`/name that is an identifier or string literal. */
function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/**
 * Collect the file-local names an `import`/destructure rename binds the async
 * entry to (`import { withWriteQueue as X }`, `const { withWriteQueue: X } = q`).
 * Calling one of these aliases invokes the entry under a name the counter never
 * sees, so every use of the alias is later rejected.
 */
function collectAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportSpecifier(node) &&
      nameText(node.propertyName) === ASYNC_ENTRY &&
      node.name.text !== ASYNC_ENTRY
    ) {
      aliases.add(node.name.text);
    }
    if (
      ts.isBindingElement(node) &&
      nameText(node.propertyName) === ASYNC_ENTRY &&
      ts.isIdentifier(node.name) &&
      node.name.text !== ASYNC_ENTRY
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

/**
 * Is `id` a *reference* to a value (a read/callee), as opposed to a declaration,
 * binding, import/export specifier, or property key? Only reference positions can
 * smuggle a call, so only they are scrutinized.
 */
function isReferencePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false; // member name
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) {
    return false;
  }
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false; // key, not value
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isLabeledStatement(p) && p.label === id) return false;
  // Shorthand `{ withWriteQueue }`: the identifier is BOTH key and value, so it
  // IS a value reference — keep it, the DI-value check decides if it is allowed.
  return true;
}

/**
 * Is `id` the value of an object property whose *name* is `withWriteQueue`? This
 * is the DI-composition seam: `{ withWriteQueue }` (shorthand) or
 * `{ withWriteQueue: shared }`. It preserves the name, so calls through the built
 * object are counted `obj.withWriteQueue(…)` — the reference hides no call.
 */
function isDiNamedPropertyValue(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) {
    return true; // `{ withWriteQueue }` — name is necessarily "withWriteQueue"
  }
  if (
    ts.isPropertyAssignment(p) &&
    p.initializer === id &&
    nameText(p.name) === ASYNC_ENTRY
  ) {
    return true; // `{ withWriteQueue: <id> }`
  }
  return false;
}

interface ScanResult {
  calls: number;
  violations: string[];
}

/** Walk one source file: count direct calls, reject every hiding indirection. */
function scanSource(fileName: string, text: string): ScanResult {
  const sourceFile = parse(fileName, text);
  const aliases = collectAliases(sourceFile);
  let calls = 0;
  const violations: string[] = [];
  const at = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  const visit = (node: ts.Node): void => {
    // Counted form: a direct call on the canonical name.
    if (ts.isCallExpression(node) && isAsyncEntryCallee(node.expression)) {
      calls += 1;
    }

    // Renamed re-export: `export { withWriteQueue as X }` — importers call X.
    if (
      ts.isExportSpecifier(node) &&
      nameText(node.propertyName) === ASYNC_ENTRY &&
      node.name.text !== ASYNC_ENTRY
    ) {
      violations.push(`renamed re-export at line ${at(node)}`);
    }

    // String-indexed reach: `q["withWriteQueue"]` — its call is uncounted.
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === ASYNC_ENTRY
    ) {
      violations.push(`element-access reach at line ${at(node)}`);
    }

    // `.withWriteQueue` accessed but NOT immediately called, and not wired into a
    // DI slot — a method value use (aliasing/passing the bound method).
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === ASYNC_ENTRY &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      violations.push(`method value use at line ${at(node)}`);
    }

    if (ts.isIdentifier(node) && isReferencePosition(node)) {
      const parent = node.parent;
      const isDirectCallCallee =
        ts.isCallExpression(parent) && parent.expression === node;

      if (node.text === ASYNC_ENTRY) {
        // The canonical identifier: a direct call is counted above; any other
        // reference is a value use unless it wires a same-named DI property.
        if (!isDirectCallCallee && !isDiNamedPropertyValue(node)) {
          violations.push(`identifier value use at line ${at(node)}`);
        }
      } else if (aliases.has(node.text)) {
        // A renamed alias: calling it is an uncounted call; any other reference
        // (except into a same-named DI property) carries it toward one.
        if (!isDiNamedPropertyValue(node)) {
          const kind = isDirectCallCallee ? "called" : "referenced";
          violations.push(
            `renamed alias '${node.text}' ${kind} at line ${at(node)}`,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, violations };
}

function scanLib(): {
  total: number;
  violationSites: string[];
  byFile: Map<string, number>;
} {
  const byFile = new Map<string, number>();
  const violationSites: string[] = [];
  let total = 0;
  for (const file of collectSourceFiles(LIB_ROOT)) {
    const text = readFileSync(file, "utf8");
    // Parse only what can possibly contribute. Every counted call and every
    // rejected indirection — a direct call, a property-access call, an import
    // rename, a destructure rename — spells the entry's name in source, so a
    // file that never mentions it yields zero calls and zero violations. The
    // AST walk costs ~15x more than this check across `src/lib`, which is what
    // kept the two whole-tree scans inside their budget as the tree grew.
    if (!text.includes(ASYNC_ENTRY)) continue;
    const { calls, violations } = scanSource(file, text);
    const rel = path.relative(LIB_ROOT, file);
    if (calls > 0) {
      byFile.set(rel, calls);
      total += calls;
    }
    for (const v of violations) violationSites.push(`${rel}: ${v}`);
  }
  return { total, violationSites, byFile };
}

describe("withWriteQueue async call-site ratchet", () => {
  it("does not grow the number of async withWriteQueue call sites", () => {
    const { total, byFile } = scanLib();

    expect(
      total,
      `async withWriteQueue call sites grew to ${total} (baseline ${BASELINE}). ` +
        `New state mutations must use withWriteQueueSync (Design 3.3). ` +
        `Current distribution: ${JSON.stringify(
          Object.fromEntries(byFile),
          null,
          2,
        )}`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("rejects every indirection that could hide an uncounted async call", () => {
    const { violationSites } = scanLib();
    expect(
      violationSites,
      `The async withWriteQueue entry was reached indirectly at: ` +
        `${violationSites.join(", ")}. Call it directly (withWriteQueue(…) or ` +
        `q.withWriteQueue(…)) so the ratchet can count it, or wire it into a ` +
        `same-named DI property.`,
    ).toEqual([]);
  });
});

describe("write-queue async-ratchet scanner", () => {
  // The counter, the indirection rules, and the DI exception are exercised on
  // synthetic sources so the guarantee — every reach for the async entry is
  // counted, rejected, or (for name-preserving DI) safely allowed — is proven
  // form by form, not left implicit in the src/lib totals.

  describe("counts direct calls in every syntactic form", () => {
    const counted: Array<[string, string]> = [
      ["bare identifier", `withWriteQueue("l", async () => {});`],
      ["explicit type args", `withWriteQueue<number>("l", async () => 1);`],
      ["property-access callee", `q.withWriteQueue("l", async () => {});`],
      ["optional-chained callee", `q?.withWriteQueue("l", async () => {});`],
      [
        "newlines before parens",
        `withWriteQueue\n  (\n  "l", async () => {});`,
      ],
      [
        "non-renamed destructure then call",
        `const { withWriteQueue } = q;\nwithWriteQueue("l", async () => {});`,
      ],
      [
        "canonical import then call",
        `import { withWriteQueue } from "@/lib/state-store";\nwithWriteQueue("l", async () => {});`,
      ],
    ];
    it.each(counted)("counts a %s call and flags nothing", (_label, src) => {
      const { calls, violations } = scanSource("fixture.ts", src);
      expect(calls).toBe(1);
      expect(violations).toEqual([]);
    });

    it("does not count the sibling entries", () => {
      const src = `q.withWriteQueueSync("l", () => 1);\nq.tryWithWriteQueue("l", async () => 1);`;
      const { calls, violations } = scanSource("fixture.ts", src);
      expect(calls).toBe(0);
      expect(violations).toEqual([]);
    });

    it("counts a call inside a .tsx file", () => {
      const src = `export const C = () => { withWriteQueue("l", async () => {}); return null; };`;
      const { calls } = scanSource("fixture.tsx", src);
      expect(calls).toBe(1);
    });
  });

  describe("allows only name-preserving DI composition of the entry", () => {
    // These mirror how the store is actually wired (store.ts / service-factory.ts):
    // the entry is referenced as the value of a `withWriteQueue`-named property,
    // so downstream calls are counted `obj.withWriteQueue(…)`.
    const allowed: Array<[string, string]> = [
      ["shorthand DI property", `const deps = { withWriteQueue };`],
      [
        "explicit DI property from a renamed import",
        `import { withWriteQueue as shared } from "./write-queue";\nconst deps = { withWriteQueue: shared };`,
      ],
    ];
    it.each(allowed)("allows %s", (_label, src) => {
      const { calls, violations } = scanSource("fixture.ts", src);
      expect(calls).toBe(0);
      expect(violations).toEqual([]);
    });
  });

  describe("rejects every indirection so no uncounted call can hide", () => {
    const smuggled: Array<[string, string]> = [
      [
        "renamed import then call",
        `import { withWriteQueue as queueWrite } from "@/lib/state-store";\nqueueWrite("l", async () => {});`,
      ],
      [
        "renamed re-export",
        `export { withWriteQueue as queueWrite } from "@/lib/state-store";`,
      ],
      ["string-indexed call", `q["withWriteQueue"]("l", async () => {});`],
      [
        "renamed destructure then call",
        `const { withWriteQueue: queueWrite } = q;\nqueueWrite("l", async () => {});`,
      ],
      [
        "method aliased to a value",
        `const f = q.withWriteQueue;\nf("l", async () => {});`,
      ],
      [
        "imported identifier passed as a value",
        `import { withWriteQueue } from "@/lib/state-store";\nregister(withWriteQueue);`,
      ],
      [
        "imported identifier assigned to a value then called",
        `import { withWriteQueue } from "@/lib/state-store";\nconst f = withWriteQueue;\nf("l", async () => {});`,
      ],
      [
        "renamed import passed as a value to a non-DI slot",
        `import { withWriteQueue as queueWrite } from "@/lib/state-store";\nregister(queueWrite);`,
      ],
    ];
    it.each(smuggled)("flags a %s and does not count it", (_label, src) => {
      const { calls, violations } = scanSource("fixture.ts", src);
      // The smuggled call is never attributed to the direct-call count...
      expect(calls).toBe(0);
      // ...and the indirection is loudly rejected instead.
      expect(violations.length).toBeGreaterThan(0);
    });
  });
});
