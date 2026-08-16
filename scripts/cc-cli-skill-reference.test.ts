import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allHelpEntries } from "../src/cli/help-registry";
import type { CommandHelpEntry } from "../src/cli/help-types";
import {
  BEGIN_MARKER,
  END_MARKER,
  SKILL_MD_PATH,
  extractReference,
  renderCommandReference,
  spliceReference,
} from "./cc-cli-skill-reference";

function entry(
  path: string[],
  summary: string,
  usage: string[],
): CommandHelpEntry {
  return {
    path,
    summary,
    description: "d",
    usage,
    flags: [],
    examples: [],
    related: [],
  };
}

describe("renderCommandReference", () => {
  it("emits one bullet per command with its summary and usage shapes", () => {
    const block = renderCommandReference([
      entry(["docs"], "manage docs", ["cctl docs <register|list>"]),
      entry(["docs", "register"], "register a doc", ["cctl docs register <p>"]),
    ]);
    expect(block).toContain("- `cctl docs` — manage docs");
    expect(block).toContain("  - `cctl docs <register|list>`");
    expect(block).toContain("- `cctl docs register` — register a doc");
    expect(block).toContain("  - `cctl docs register <p>`");
  });

  it("groups children under their top-level command in registry order", () => {
    const block = renderCommandReference([
      entry(["ask"], "ask", ["cctl ask"]),
      entry(["dev"], "dev group", ["cctl dev <list>"]),
      entry(["dev", "list"], "list servers", ["cctl dev list"]),
    ]);
    const askIdx = block.indexOf("`cctl ask`");
    const devIdx = block.indexOf("`cctl dev`");
    const devListIdx = block.indexOf("`cctl dev list`");
    expect(askIdx).toBeLessThan(devIdx);
    expect(devIdx).toBeLessThan(devListIdx);
  });

  it("omits retired commands from the portable reference", () => {
    const retired: CommandHelpEntry = {
      ...entry(["spec", "task"], "retired task history", ["cctl spec task"]),
      includeInGeneratedReference: false,
    };

    const block = renderCommandReference([
      entry(["spec"], "spec work", ["cctl spec"]),
      retired,
    ]);

    expect(block).not.toContain("cctl spec task");
  });
});

describe("spliceReference / extractReference", () => {
  const source = `intro\n${BEGIN_MARKER}\nOLD\n${END_MARKER}\noutro\n`;

  it("replaces only the text between the markers", () => {
    const next = spliceReference(source, "NEW\n");
    expect(next).toBe(`intro\n${BEGIN_MARKER}\nNEW\n\n${END_MARKER}\noutro\n`);
    expect(next.startsWith("intro\n")).toBe(true);
    expect(next.endsWith("outro\n")).toBe(true);
  });

  it("round-trips: extract after splice recovers the block (trimmed)", () => {
    const next = spliceReference(source, "line one\nline two\n");
    expect(extractReference(next)).toBe("line one\nline two");
  });

  it("throws when a marker is absent", () => {
    expect(() => spliceReference("no markers here", "x")).toThrow(/marker/);
  });
});

describe("committed SKILL.md stays in sync with the registry (the CI check)", () => {
  it("publishes every one-off lifecycle verb and no removed release verb", () => {
    const reference = renderCommandReference(allHelpEntries());

    expect(reference).toContain("`cctl workflow run`");
    expect(reference).toContain("`cctl workflow wait`");
    expect(reference).toContain(
      "`cctl workflow status [<executionId>] [--json]`",
    );
    expect(reference).toContain("`cctl workflow abandon`");
    expect(reference).not.toMatch(/workflow live release|live release/);
  });

  it("the on-disk command reference equals the freshly-rendered block", () => {
    // This is the drift gate: if a command's registry entry changes and the
    // generator is not re-run, the committed block no longer matches — exactly
    // the failure `bun scripts/cc-cli-skill-reference.ts --check` reports in CI.
    const source = readFileSync(SKILL_MD_PATH, "utf8");
    const current = extractReference(source);
    expect(
      current,
      `SKILL.md is missing the ${BEGIN_MARKER}/${END_MARKER} markers`,
    ).not.toBeNull();
    const expected = renderCommandReference(allHelpEntries()).trim();
    expect(
      current,
      "cc-cli SKILL.md command reference is stale — run `bun scripts/cc-cli-skill-reference.ts`",
    ).toBe(expected);
    expect(current).toContain(
      "cctl spec start <slug> [--inputs .cc/temp/inputs.json] [--park]",
    );
    expect(current).toContain(
      "cctl spec plan preview <slug> --stage draft|proposed",
    );
    expect(current).not.toMatch(/cctl spec task|materialized graph/i);
  });
});
