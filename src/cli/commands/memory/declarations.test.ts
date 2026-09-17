import { describe, expect, it } from "vitest";

import { MEMORY_ADVISORY_CONTRACT } from "@/lib/memory/advisory-contract";

import { memoryGroups, memorySpecs } from "./definitions";

const declarations = [...memoryGroups, ...Object.values(memorySpecs)];
function declarationText(command: string): string {
  const declaration = declarations.find(({ path }) => path === command);
  if (!declaration) throw new Error(`Missing memory declaration: ${command}`);
  return [
    declaration.description,
    ...("flags" in declaration
      ? Object.values(declaration.flags).map(({ description }) => description)
      : []),
  ].join("\n");
}
function allDeclarationText(): string {
  return declarations.map(({ path }) => declarationText(path)).join("\n");
}

/**
 * The word-capped advisory contract (`MEMORY_ADVISORY_CONTRACT`) states each
 * memory rule once for every agent; help is where the same rule is restated at
 * the surface that can act on it. Spec R5.4/D10 assign the rules per surface,
 * and this table is that assignment: a cell is one rule owed by one command,
 * pinned to a stable phrase so a rewrite that drops it fails by name rather
 * than leaving the rule with no surface at all.
 */
const RULE_PHRASES: Record<string, string[]> = {
  "hook-authorship": ["the hook is the whole index entry"],
  "body-reading": ["the mechanism or the exact command"],
  // Two phrases, because the mechanics alone are not the rule: a surface that
  // says only which mode competes leaves the reader to guess WHEN `always` is
  // warranted, and leaf help never inherits the group's context to find out.
  "index-modes": [
    "auto competes, always reserves a slot, search-only never competes",
    "a trap that bites regardless of the task",
  ],
  linking: ["the ticket, spec, or workflow it is about"],
  "status-note": ["goes in the statusNote, never in the hook"],
  "recall-before-concluding": ["recall before you conclude"],
  "delta-meaning": ["carries only what changed since your last turn"],
  "status-shows-claim": ["prints the status line you are re-asserting"],
};

type RuleName = keyof typeof RULE_PHRASES & string;

const RULES_BY_SURFACE: {
  command: string;
  rules: RuleName[];
}[] = [
  {
    command: "memory",
    rules: [
      "hook-authorship",
      "body-reading",
      "index-modes",
      "linking",
      "status-note",
      "recall-before-concluding",
    ],
  },
  {
    command: "memory recall",
    rules: ["recall-before-concluding", "body-reading"],
  },
  {
    command: "memory index",
    rules: ["recall-before-concluding", "delta-meaning"],
  },
  {
    command: "memory create",
    rules: ["hook-authorship", "index-modes", "linking", "status-note"],
  },
  { command: "memory link", rules: ["linking"] },
  {
    command: "memory update",
    rules: ["status-note", "index-modes"],
  },
  {
    command: "memory mark-reviewed",
    rules: ["status-note", "status-shows-claim"],
  },
];

describe("memory declarations carry the contract's rules surface by surface", () => {
  for (const surface of RULES_BY_SURFACE) {
    for (const rule of surface.rules) {
      it(`${surface.command} carries the ${rule} rule`, () => {
        const text = declarationText(surface.command);
        for (const phrase of RULE_PHRASES[rule] ?? []) {
          expect(text).toContain(phrase);
        }
      });
    }
  }
});

describe("memory declarations agree with the always-injected contract", () => {
  it("restates the contract's own wording for every shared rule", () => {
    for (const phrase of [
      ...(RULE_PHRASES["hook-authorship"] ?? []),
      ...(RULE_PHRASES["body-reading"] ?? []),
      ...(RULE_PHRASES["index-modes"] ?? []).slice(1),
      ...(RULE_PHRASES.linking ?? []),
      ...(RULE_PHRASES["status-note"] ?? []),
      ...(RULE_PHRASES["recall-before-concluding"] ?? []),
    ]) {
      expect(
        MEMORY_ADVISORY_CONTRACT.toLowerCase(),
        `the contract must carry '${phrase}' for the help to restate it`,
      ).toContain(phrase.toLowerCase());
    }
  });

  it("does not claim the index block rides every turn", () => {
    const allText = allDeclarationText();
    expect(allText).not.toMatch(
      /rides every turn|with each turn|on every turn/iu,
    );
  });

  /**
   * Delivery is decided by scope, index mode, and the block's budget, so no act
   * can promise a note or a status line reaches every conversation. A re-lease
   * restores eligibility; the S1 probe's lesson is that an operator must be able
   * to read what they are re-asserting, not that the line is guaranteed a slot.
   */
  it("never promises a note or status line reaches every conversation's block", () => {
    const allText = allDeclarationText();
    expect(allText).not.toMatch(/every conversation'?s block/iu);
  });

  it("bounds a status re-lease by scope, index mode, and budget", () => {
    const text = declarationText("memory mark-reviewed");
    expect(text).toContain("Eligible is not delivered");
    for (const bound of ["scope", "index mode", "budget"]) {
      expect(text).toContain(bound);
    }
  });
});
