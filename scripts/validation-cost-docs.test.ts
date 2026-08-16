import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validationCommandCostSchema } from "../src/lib/validation/schemas";

/**
 * The documentation contract for `validation.commands[].cost`. Cost became a
 * union — a scalar or a per-scope table — and the surfaces that teach it are
 * spread across docs, steering, and two near-duplicate plugin skill references.
 * Every claim here is checked against the shipped schema or against the other
 * copy, never against a third copy of the same prose, so a doc that keeps
 * describing the old scalar-only field fails here instead of misleading the
 * next project setup.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Live surfaces that teach the cost contract to a human or an agent. */
const COST_DOC_SURFACES = [
  "docs/project-configuration.md",
  "docs/ai-validation-output.md",
  ".kiro/steering/project-configuration.md",
  "plugins/command-center/command-center/skills/project-setup/references/commandcenter-json.md",
  "plugins/command-center/command-center/skills/dev-server-setup/references/commandcenter-json.md",
] as const;

const SKILL_REFERENCE_COPIES = [
  "plugins/command-center/command-center/skills/project-setup/references/commandcenter-json.md",
  "plugins/command-center/command-center/skills/dev-server-setup/references/commandcenter-json.md",
] as const;

function read(relativePath: string): string {
  return readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

/**
 * `toContain` on a 20 KB document prints the whole document on failure, which
 * buries the one missing phrase. Assert on the boolean and carry the phrase in
 * the message instead.
 */
function expectDocuments(doc: string, phrase: string, why: string): void {
  expect(doc.includes(phrase), `${why} — missing: ${phrase}`).toBe(true);
}

/**
 * The table keys taken from a value the schema actually accepted, so a rename
 * in `validationCommandCostSchema` lands here rather than silently leaving the
 * docs naming a field that no longer exists.
 */
function acceptedTableKeys(): readonly string[] {
  const maximal = validationCommandCostSchema.parse({
    full: 4,
    changed: 2,
    paths: { base: 1, perPath: 1 },
  });
  if (typeof maximal === "number") {
    throw new Error("expected the table branch of validationCommandCostSchema");
  }
  const { paths } = maximal;
  if (paths === undefined) {
    throw new Error("expected the parsed table to retain its paths block");
  }
  return [...Object.keys(maximal), ...Object.keys(paths)];
}

/**
 * A markdown section, from its heading to the next heading of the same or a
 * shallower depth.
 */
function section(doc: string, heading: string): string {
  const lines = doc.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0);
  const depth = heading.match(/^#+/)?.[0].length ?? 0;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const match = line.match(/^#+/);
    return match !== null && match[0].length <= depth;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

describe("validation cost documentation", () => {
  it("names every cost-table field the schema accepts on each surface", () => {
    const keys = acceptedTableKeys();
    for (const surface of COST_DOC_SURFACES) {
      const doc = read(surface);
      for (const key of keys) {
        expectDocuments(
          doc,
          key,
          `${surface} must teach the cost-table field "${key}"`,
        );
      }
    }
  });

  it("types the cost field as a union wherever a field table declares it", () => {
    for (const surface of COST_DOC_SURFACES) {
      const rows = read(surface)
        .split("\n")
        .filter((line) => /^\|\s*`cost`\s*\|/.test(line));
      for (const row of rows) {
        expect(
          row.includes("{"),
          `${surface} types cost as a scalar only: ${row.trim()}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the ValidationCommand contract identical across skill copies", () => {
    const [first, second] = SKILL_REFERENCE_COPIES;
    expect(
      section(read(second), "### ValidationCommand"),
      `${second} has drifted from ${first}; the copies differ only on dev-server wording`,
    ).toBe(section(read(first), "### ValidationCommand"));
  });

  it("does not claim cost is shared across scope variants", () => {
    // Phrases that were true of the scalar-only field and are false of the table.
    const retiredClaims = [
      "`cost` and `timeoutMs` are shared by both variants",
      "Both variants share `cost` and `timeoutMs`",
      "register the same number as the command cost",
      "under its shared cost and timeout",
    ];
    // The CLI help registry teaches the same contract to every agent.
    for (const surface of [
      ...COST_DOC_SURFACES,
      "src/cli/commands/validate.help.ts",
    ]) {
      const doc = read(surface);
      for (const claim of retiredClaims) {
        expect(doc.includes(claim), `${surface} still asserts: ${claim}`).toBe(
          false,
        );
      }
    }
  });
});
