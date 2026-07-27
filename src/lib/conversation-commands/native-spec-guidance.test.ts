import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { expandNativeSpecCommandForAgent } from "./native-spec";
import {
  extractSpecCommandGuidance,
  renderRuntimeSpecInstructions,
  renderSpecCommandGuidance,
  SPEC_GUIDANCE_BEGIN_MARKER,
  SPEC_GUIDANCE_END_MARKER,
  SPEC_GUIDANCE_SECTIONS,
  spliceSpecCommandGuidance,
} from "./native-spec-guidance";

const COMMAND_DOC_PATH = path.join(
  process.cwd(),
  ".claude",
  "commands",
  "spec.md",
);

// Both surfaces hard-wrap prose, so a fact can straddle a line break in one
// surface and not the other. Comparing flattened text keeps the parity gate
// about content rather than wrapping.
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

interface GuidanceFact {
  readonly id: string;
  readonly required: readonly RegExp[];
  readonly forbidden?: readonly RegExp[];
}

/**
 * Facts an agent cannot recover from anywhere else: the CLI help registry
 * documents single verbs, not the lifecycle that sequences them. Every fact
 * here must hold on both the runtime `/spec` expansion and the repository
 * command document, because an agent in another repository only ever sees the
 * runtime one.
 */
const GUIDANCE_FACTS: readonly GuidanceFact[] = [
  {
    id: "cross-spec discovery is `spec list` or `spec search --all`, while a bare `spec search` is scoped to one spec",
    required: [
      /`cctl spec list`/,
      /`cctl spec search --all <query>`/,
      /`cctl spec search <slug> <query>`/,
      /within (that|this|one) (one )?spec/i,
    ],
    // Two ways this has been wrong. The original lie paired list and search as
    // if a bare `spec search` answered "does a competing spec already exist";
    // the correction then outlived itself by calling `spec list` the only
    // cross-spec discovery after `--all` shipped. Parity across the two
    // surfaces cannot catch either, because both render from one module.
    forbidden: [
      /`cctl spec list` and `cctl spec search`/,
      /`cctl spec list` is the only cross-spec discovery/,
    ],
  },
  {
    id: "authoring is staged and the stage is the server-enforced write boundary",
    required: [
      /`cctl spec status`/,
      /`stage_blocked`/,
      /requirements[\s\S]{0,180}design[\s\S]{0,180}plan/,
    ],
  },
  {
    id: "a stage is concluded by propose, or by advance under a Notify/Off dial",
    required: [
      /`cctl spec propose <slug>`/,
      /`cctl spec advance <slug> --from <requirements\|design>`/,
      /Notify or Off/,
      /dial is Gate/,
    ],
  },
  {
    id: "an approved spec continues through an amendment",
    required: [/`cctl spec amend <slug>`/, /amendment/i],
  },
  {
    id: "`spec start` parks at definition review and hands off to `workflow start`",
    required: [
      /`cctl spec start <slug> --file <scope\.json>`/,
      /`definition_review`/,
      /`cctl workflow start <definitionId>`/,
      /human approval boundary/i,
    ],
  },
  {
    id: "gate policy changes are a human-only Spec Studio act",
    required: [/gate policy/i, /`human_act_required`/, /Spec Studio/],
  },
  {
    id: "proof verdicts are machine-recorded and the human remedy is a waiver",
    required: [
      /Proof verdicts are recorded only by the delivery gate from machine\s+evidence/,
      /Controls → Merge gate → Waive/,
    ],
    forbidden: [
      // The old copy promised a Spec Studio proof-verdict surface that no
      // longer exists.
      /record proof verdicts on the user's behalf/,
      /waivers, proof verdicts/,
    ],
  },
];

const commandDoc = readFileSync(COMMAND_DOC_PATH, "utf8");

const surfaces: readonly (readonly [string, string])[] = [
  [
    "runtime /spec expansion",
    flatten(expandNativeSpecCommandForAgent("/spec")),
  ],
  ["repository .claude/commands/spec.md", flatten(commandDoc)],
];

describe("native spec guidance parity", () => {
  for (const [surfaceName, surface] of surfaces) {
    describe(surfaceName, () => {
      for (const fact of GUIDANCE_FACTS) {
        it(`states that ${fact.id}`, () => {
          for (const pattern of fact.required) {
            expect(surface).toMatch(pattern);
          }
          for (const pattern of fact.forbidden ?? []) {
            expect(surface).not.toMatch(pattern);
          }
        });
      }
    });
  }

  it("keeps .claude/commands/spec.md byte-identical to the rendered guidance", () => {
    expect(extractSpecCommandGuidance(commandDoc)).toBe(
      renderSpecCommandGuidance(),
    );
  });

  it("keeps the composer frontmatter outside the generated block", () => {
    // discoverCommands reads this frontmatter; a generated block that swallowed
    // it would drop /spec from the command catalog.
    const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(commandDoc) ?? [];

    expect(frontmatter).toMatch(/description:/);
    expect(frontmatter).toMatch(/argument-hint:/);
    expect(frontmatter?.includes(SPEC_GUIDANCE_BEGIN_MARKER)).toBe(false);
  });

  it("round-trips a spliced block through extraction", () => {
    const source = [
      "# Native Spec Authoring",
      "",
      SPEC_GUIDANCE_BEGIN_MARKER,
      "",
      "## Stale heading",
      "",
      SPEC_GUIDANCE_END_MARKER,
      "",
    ].join("\n");

    const spliced = spliceSpecCommandGuidance(
      source,
      renderSpecCommandGuidance(),
    );

    expect(extractSpecCommandGuidance(spliced)).toBe(
      renderSpecCommandGuidance(),
    );
    expect(spliced).toContain("# Native Spec Authoring");
    expect(spliced).not.toContain("## Stale heading");
  });

  it("refuses to splice a document without the markers", () => {
    expect(() =>
      spliceSpecCommandGuidance("# No markers here", "body"),
    ).toThrow(/marker/i);
  });

  it("delivers every shared section to the runtime surface", () => {
    const runtime = renderRuntimeSpecInstructions();

    for (const section of SPEC_GUIDANCE_SECTIONS) {
      const delivered = runtime.includes(`## ${section.heading}`);
      expect(delivered).toBe(section.audience === "shared");
    }
  });
});
