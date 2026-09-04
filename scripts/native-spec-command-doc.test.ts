import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allHelpEntries, allSuccessHintRows } from "../src/cli/help-registry";
import { pathKey } from "../src/cli/help-types";
import {
  renderSpecCommandGuidance,
  SPEC_GUIDANCE_BEGIN_MARKER,
  SPEC_GUIDANCE_END_MARKER,
} from "../src/lib/conversation-commands/native-spec-guidance";
import {
  renderSpecCommandDoc,
  SPEC_COMMAND_DOC_PATH,
} from "./native-spec-command-doc";

/**
 * The two documents that POINT at the owning section rather than restating it
 * (#80 design 3.6): the generated `/spec` guidance and the native-SDD skill.
 * Both are checked here because the defect is symmetric — a sequence copied
 * into either one drifts from the receipts that actually walk it.
 */
const NATIVE_SDD_SKILL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins/command-center/command-center/skills/native-sdd-authoring/SKILL.md",
);

const OWNING_SECTION = "Delivering a native spec";
const OWNING_SKILL = "graph-workflow-planning";

const REGISTRY_KEYS = new Set(
  allHelpEntries().map((entry) => pathKey(entry.path)),
);

/**
 * The leading registered command of a free-text label, so a hint row's `after`
 * ("workflow replace or edit on a managed draft (…)") yields the verb rather
 * than the whole sentence.
 */
function leadingCommand(label: string): string {
  const prefixesACommand = (candidate: string): boolean => {
    for (const key of REGISTRY_KEYS) {
      if (key === candidate || key.startsWith(`${candidate} `)) return true;
    }
    return false;
  };
  let command = "";
  for (const word of label.split(/\s+/u).filter(Boolean)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(word)) break;
    const next = command ? `${command} ${word}` : word;
    if (!prefixesACommand(next)) break;
    command = next;
  }
  return command;
}

/** One-sentence granularity: a restated row names both of its ends together. */
function sentences(document: string): string[] {
  return document.replace(/\s+/gu, " ").split(/(?<=[.:])\s+/u);
}

function routingDocuments(): ReadonlyArray<readonly [string, string]> {
  return [
    ["the generated /spec guidance", renderSpecCommandGuidance()],
    [
      "the native-sdd-authoring skill",
      readFileSync(NATIVE_SDD_SKILL_PATH, "utf8"),
    ],
  ] as const;
}

/**
 * Every command the launch chain names, as a `cctl` citation: both ends of each
 * shipped row. A pointer document may name one of these for what it IS; naming
 * two in one sentence is a launch row restated in prose.
 */
const LAUNCH_PATH_COMMANDS = [
  ...new Set(
    allSuccessHintRows().flatMap((row) => [
      leadingCommand(row.after),
      row.names.join(" "),
    ]),
  ),
]
  .filter((command) => command.length > 0)
  .map((command) => `cctl ${command}`);

/**
 * The prose shape of a launch row that cites only one command, which the
 * sample-and-adjacency checks cannot see: "After sign-off, run `cctl spec
 * start`". Deliberately narrow — a sentence-initial cue, a comma, then an
 * imperative — so ordinary prose that merely contains "after" is untouched.
 */
const SEQUENCED_IMPERATIVE =
  /^(After|Once|Then)\b[^,]{0,60},\s+(run|use|read|author|open|submit|edit|write)\b/iu;

/**
 * The other half of the same shape: "do X, then do Y". Scoped to sentences that
 * cite a launch-path command, because an ordinary two-step over one surface
 * ("author the payload, then submit it with `cctl ask`") is not a launch row.
 */
const THEN_CONNECTOR =
  /,\s+then\s+(run|use|read|author|open|submit|edit|write|propose|start|replace|validate)\b/iu;

describe("managed delivery routes to its owning section (#80 design 3.6)", () => {
  it.each(routingDocuments())(
    "%s points at the owning section and names Workflow Builder once",
    (_name, document) => {
      const flat = document.replace(/\s+/gu, " ");

      expect(flat).toContain(OWNING_SECTION);
      expect(flat).toContain(OWNING_SKILL);
      // Named once, and only as the surface a human reviews on: two mentions
      // is how it became a second authoring path in the first place.
      expect((flat.match(/Workflow Builder/gu) ?? []).length).toBe(1);
    },
  );

  it.each(routingDocuments())(
    "%s carries no second copy of the launch hint chain",
    (_name, document) => {
      const flat = document.replace(/\s+/gu, " ");
      const lines = sentences(document);

      for (const row of allSuccessHintRows()) {
        expect(
          flat.includes(row.sample().replace(/\s+/gu, " ")),
          `a hint the receipt already renders is copied here: ${row.sample()}`,
        ).toBe(false);

        const after = `cctl ${leadingCommand(row.after)}`;
        const next = `cctl ${row.names.join(" ")}`;
        if (after === next) continue;
        for (const sentence of lines) {
          expect(
            sentence.includes(after) && sentence.includes(next),
            `this sentence restates the chain row "${row.after}" -> ${next}: ${sentence}`,
          ).toBe(false);
        }
      }
    },
  );
  it.each(routingDocuments())(
    "%s states each act by its role rather than as a launch row",
    (_name, document) => {
      for (const sentence of sentences(document)) {
        const cited = LAUNCH_PATH_COMMANDS.filter((command) =>
          sentence.includes(command),
        );
        expect(
          cited.length,
          `one sentence sequences ${cited.join(" and ")}: ${sentence}`,
        ).toBeLessThan(2);

        expect(
          SEQUENCED_IMPERATIVE.test(sentence) && sentence.includes("cctl "),
          `a launch row restated in prose: ${sentence}`,
        ).toBe(false);

        expect(
          THEN_CONNECTOR.test(sentence) && cited.length > 0,
          `a launch act sequenced into the next one: ${sentence}`,
        ).toBe(false);
      }
    },
  );
});

const staleDoc = [
  "---",
  "description: Author a durable native Command Center spec in this conversation",
  "argument-hint: <what-to-specify>",
  "---",
  "",
  "# Native Spec Authoring",
  "",
  "Author a native Command Center spec for `$ARGUMENTS` in this conversation.",
  "",
  SPEC_GUIDANCE_BEGIN_MARKER,
  "",
  "## Stale heading",
  "",
  "Guidance that the module no longer states.",
  "",
  SPEC_GUIDANCE_END_MARKER,
  "",
].join("\n");

describe("renderSpecCommandDoc", () => {
  it("replaces a stale block and leaves the frontmatter and intro untouched", () => {
    const next = renderSpecCommandDoc(staleDoc);

    expect(next).toContain("argument-hint: <what-to-specify>");
    expect(next).toContain(
      "Author a native Command Center spec for `$ARGUMENTS` in this conversation.",
    );
    expect(next).not.toContain("## Stale heading");
    expect(next).toContain(renderSpecCommandGuidance());
  });

  it("is idempotent, so regenerating a fresh document is a no-op", () => {
    const fresh = renderSpecCommandDoc(staleDoc);

    expect(renderSpecCommandDoc(fresh)).toBe(fresh);
  });

  it("refuses a document that declares no generated block", () => {
    expect(() => renderSpecCommandDoc("# Native Spec Authoring\n")).toThrow(
      /marker/i,
    );
  });
});

describe("committed .claude/commands/spec.md stays in sync with the guidance module", () => {
  it("is byte-identical to what the generator writes", () => {
    // The drift gate: editing the guidance module without re-running the
    // generator leaves the repository document stating something the runtime
    // `/spec` expansion no longer says — exactly what
    // `bun scripts/native-spec-command-doc.ts --check` reports in CI.
    const source = readFileSync(SPEC_COMMAND_DOC_PATH, "utf8");

    expect(
      renderSpecCommandDoc(source),
      ".claude/commands/spec.md is stale — run `bun scripts/native-spec-command-doc.ts`",
    ).toBe(source);
  });
});
