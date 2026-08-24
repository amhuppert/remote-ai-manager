import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDANCE_PREFIXES } from "./guidance-prefixes";
import {
  lineLeadingLabels,
  readCliSources,
  stringLiterals,
  type CliSourceFile,
} from "./testing/source-scan";

const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".",
);

const ALLOWED = new Set<string>(Object.keys(GUIDANCE_PREFIXES));

/**
 * Spellings that an agent reads as a feedback tier. They are enumerated
 * because "guidance" is not a property of the WORD before the colon —
 * `artifact:`, `session:`, and `history:` are data labels inside a command's
 * body, and a sweep that failed on every unfamiliar label would fail on all of
 * them. What can be enumerated is the vocabulary that COMPETES with the six:
 * words that promise the reader an action, a caveat, or a severity, which is
 * exactly how the retired `note:` advisory read as a fourth tier.
 */
const COMPETING_SPELLINGS = [
  "note",
  "notes",
  "tip",
  "protip",
  "advice",
  "advisory",
  "suggestion",
  "recommendation",
  "guidance",
  "caution",
  "warning",
  "warn",
  "alert",
  "important",
  "attention",
  "notice",
  "remember",
  "todo",
  "action",
  "must",
  "fyi",
  "nb",
  "heads-up",
  "next-step",
  "next-steps",
];

/**
 * Sites where a competing spelling is pinned rather than migrated, keyed
 * `<file>:<label>`. Both are severity labels on a FINDING inside diagnostic
 * output, where the surrounding lines are the report itself — not a next step
 * appended after a result. A third one is a reviewed edit here.
 */
const DECLARED_SITES: Readonly<Record<string, string>> = {
  "commands/doctor.ts:warning":
    "`doctor` reports a build-stamp mismatch on stderr while still exiting 0 — the diagnosis is the command's whole output, and the recovery line follows it",
  "commands/workflow.ts:warning":
    "`workflow validate` labels each advisory plan finding, one per line, alongside the located issue lines it prints on refusal",
};

interface PrefixUse {
  readonly site: string;
  readonly label: string;
  readonly line: string;
}

function competingPrefixUses(sources: readonly CliSourceFile[]): PrefixUse[] {
  const uses: PrefixUse[] = [];
  for (const file of sources) {
    for (const literal of stringLiterals(file.source)) {
      for (const label of lineLeadingLabels(literal)) {
        if (ALLOWED.has(label)) continue;
        if (!COMPETING_SPELLINGS.includes(label)) continue;
        uses.push({
          site: `${file.relativePath}:${label}`,
          label,
          line: literal.slice(0, 60),
        });
      }
    }
  }
  return uses;
}

/**
 * The guidance-vocabulary ratchet (docs/design/cc-cli/09 §10). Tier arbitration
 * is owned by one seam, but nothing stops a command from printing its own
 * advisory line above it — which is how the `.cc/temp` payload advisory spent
 * its life as a `note:` that `--json` callers never saw.
 */
describe("guidance prefix vocabulary", () => {
  it("never competes with the enumerated prefixes", async () => {
    const uses = competingPrefixUses(await readCliSources(CLI_ROOT));

    const undeclared = [
      ...new Set(
        uses
          .filter((use) => DECLARED_SITES[use.site] === undefined)
          .map((use) => `${use.site} — "${use.line}…"`),
      ),
    ].sort();
    expect(
      undeclared,
      `these lines open with a prefix an agent reads as a tier: use one of ${[...ALLOWED].join(", ")}, or move the text into the primary body`,
    ).toEqual([]);

    const sites = new Set(uses.map((use) => use.site));
    const stale = Object.keys(DECLARED_SITES)
      .filter((site) => !sites.has(site))
      .sort();
    expect(
      stale,
      "these declared prefix sites are gone — drop them so the exception list keeps describing reality",
    ).toEqual([]);
  });

  it("flags a new advisory vocabulary wherever it is introduced", () => {
    const uses = competingPrefixUses([
      {
        relativePath: "commands/new-command.ts",
        source: [
          'const advisory = "note: payload files belong under .cc/";',
          "const body = `rows: ${count}`;",
          'const guidance = "hint: run `cctl dev list`";',
        ].join("\n"),
      },
    ]);

    expect(uses.map((use) => use.site)).toEqual([
      "commands/new-command.ts:note",
    ]);
  });

  it("renders the tier lines from the vocabulary", () => {
    // The seam's own labels come from the table, so `guidanceLine("note", …)`
    // is a type error rather than a seventh tier nobody reviewed.
    expect(Object.keys(GUIDANCE_PREFIXES)).toEqual([
      "instruction",
      "reminder",
      "hint",
      "next",
      "context",
      "why",
    ]);
    for (const [key, prefix] of Object.entries(GUIDANCE_PREFIXES)) {
      expect(prefix).toBe(key);
    }
  });
});
