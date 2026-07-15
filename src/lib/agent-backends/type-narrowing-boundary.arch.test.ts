import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Architecture test (Phase 1 backend-seam review, finding 10): type
 * narrowing into the closed `AgentBackendId` union is confined to the ONE
 * sanctioned fiction — `TESTFAKE_BACKEND_ID` in `testing/testfake-backend.ts`
 * (design Blocker 4, D-B4.2), which runtime-verifies "testfake" against the
 * widened schema before narrowing. Everywhere else in the seam, backend ids
 * flow from literals checked by `satisfies`/annotations or from
 * `agentBackendSchema` parses — never from an `as` assertion.
 *
 * The same scan pins the seam's `as unknown as` double assertions at their
 * current survivor set (external SDK type workarounds only, per-file exact
 * counts). Entries may only ever be REMOVED or decremented; new untyped
 * escapes belong behind a runtime check (`safeParse`, `Reflect.get` + type
 * guard) instead.
 */

const SEAM_ROOT = __dirname;

const AGENT_BACKEND_ID_ASSERTION = /as AgentBackendId\b/g;
const DOUBLE_ASSERTION = /as unknown as\b/g;

const SANCTIONED_NARROWING_FILE = "testing/testfake-backend.ts";

/** file (relative to src/lib/agent-backends/) → exact `as unknown as` count.
 *  All entries wrap external SDK values whose published types are missing or
 *  demonstrably wrong. Shrink counts as they burn down; never add or raise. */
const DOUBLE_ASSERTION_ALLOWLIST: ReadonlyMap<string, number> = new Map([
  // Claude SDK McpServerConfig union lacks the `type` discriminant field
  // present on the wire; the cast reads it behind a runtime typeof check.
  ["mcp-translation.ts", 1],
  // @openai/codex-sdk client/usage types diverge from observed runtime
  // shapes; both casts adapt the SDK object to the locally-typed port.
  ["codex/task-runner.ts", 2],
  ["codex/conversation-runtime.ts", 1],
]);

function listSeamSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...listSeamSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("agent-backends type-narrowing boundary", () => {
  it("permits exactly one `as AgentBackendId` narrowing: TESTFAKE_BACKEND_ID", () => {
    const offenders: string[] = [];
    let sanctionedCount = 0;

    for (const file of listSeamSourceFiles(SEAM_ROOT)) {
      const rel = path.relative(SEAM_ROOT, file);
      const count = countMatches(
        readFileSync(file, "utf8"),
        AGENT_BACKEND_ID_ASSERTION,
      );
      if (count === 0) continue;
      if (rel === SANCTIONED_NARROWING_FILE) {
        sanctionedCount = count;
        continue;
      }
      offenders.push(`${rel} (${count})`);
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
    expect(
      sanctionedCount,
      `${SANCTIONED_NARROWING_FILE} must contain exactly the TESTFAKE_BACKEND_ID narrowing`,
    ).toBe(1);
  });

  it("pins `as unknown as` double assertions to the allowlisted survivor set", () => {
    const violations: string[] = [];

    for (const file of listSeamSourceFiles(SEAM_ROOT)) {
      const rel = path.relative(SEAM_ROOT, file);
      const observed = countMatches(
        readFileSync(file, "utf8"),
        DOUBLE_ASSERTION,
      );
      const allowed = DOUBLE_ASSERTION_ALLOWLIST.get(rel) ?? 0;
      if (observed === allowed) continue;
      violations.push(
        observed > allowed
          ? `${rel}: ${observed} double assertion(s), allowlist permits ${allowed}`
          : `${rel}: allowlist is stale (permits ${allowed}, found ${observed}) — shrink it`,
      );
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("allowlisted files still exist (stale entries must be deleted)", () => {
    for (const [rel] of DOUBLE_ASSERTION_ALLOWLIST) {
      expect(
        statSync(path.join(SEAM_ROOT, rel)).isFile(),
        `${rel} missing`,
      ).toBe(true);
    }
  });
});
