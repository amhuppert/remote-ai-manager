// @vitest-inputs plugins/command-center/command-center/skills/**
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCommandCenterCli } from "../src/cli/framework/application";
import {
  BEGIN_MARKER,
  COMMAND_REFERENCE_PATH,
  END_MARKER,
  extractBlock,
  nativeHelpNodes,
  proseUsageFindings,
  renderCommandReference,
  skillDocumentPaths,
  spliceBlock,
} from "./cc-cli-skill-reference";

const cli = createCommandCenterCli(async () => {
  throw new Error("Reference generation must remain offline");
});

const fenced = (body: string) => `# doc\n\n\`\`\`sh\n${body}\n\`\`\`\n`;

describe("native help reference", () => {
  it("collects CC domain declarations for the portable reference", () => {
    const nodes = nativeHelpNodes(cli);
    expect(
      nodes.find((node) => node.path === "ticket import")?.flags,
    ).toContainEqual(
      expect.objectContaining({ name: "archive", source: "domain" }),
    );
    expect(new Set(nodes.map((node) => node.path)).size).toBe(nodes.length);
  });

  it("renders registry usage and flags including structured input admission", () => {
    const nodes = nativeHelpNodes(cli);
    const reference = renderCommandReference(nodes);
    expect(reference).toContain("`--archive`");
    for (const node of nodes) {
      if (node.kind === "root") continue;
      expect(reference).toContain(`\`cctl ${node.path}\``);
      for (const usage of node.usage)
        expect(reference).toContain(`\`${usage}\``);
    }
  });

  it("keeps the committed generated reference equal to the native registry", () => {
    expect(
      extractBlock(
        readFileSync(COMMAND_REFERENCE_PATH, "utf8"),
        BEGIN_MARKER,
        END_MARKER,
      ),
    ).toBe(renderCommandReference(nativeHelpNodes(cli)).trim());
  });
});

describe("prose command contracts", () => {
  it("accepts concrete or parameterized native invocations and comments", () => {
    expect(
      proseUsageFindings(
        fenced(
          [
            "cctl ticket import --archive <path> [--project <project>]",
            "cctl dev stop web # stopped",
            "cctl notify 'use --obsolete only in this quoted explanation' --title CI",
            "cctl validate run test --json -- src/example.test.ts",
          ].join("\n"),
        ),
        nativeHelpNodes(cli),
      ),
    ).toEqual([]);
  });

  it("detects removed verbs and flags in examples as well as usage shapes", () => {
    const findings = proseUsageFindings(
      fenced(
        [
          "cctl dev restart web",
          "cctl ask --question 'Which one?' --option first --option second",
          "cctl ticket import --file .cc/temp/archive.gz",
        ].join("\n"),
      ),
      nativeHelpNodes(cli),
    );
    expect(findings.map((finding) => finding.reason)).toEqual([
      "unknown-command",
      "unknown-flag",
      "unknown-flag",
    ]);
    expect(findings[1]?.expected).toContain("--file");
    expect(findings[2]?.expected).toContain("--archive");
  });

  it("ignores quoted content, positionals after --, prose, and generated blocks", () => {
    const source =
      `Run cctl removed.\n${BEGIN_MARKER}\n${fenced("cctl removed")}\n${END_MARKER}\n` +
      fenced("cctl notify -- '--not-a-flag'");
    expect(proseUsageFindings(source, nativeHelpNodes(cli))).toEqual([]);
  });

  it("checks continuation lines", () => {
    expect(
      proseUsageFindings(
        fenced("cctl ask \\\n  --question 'retired sugar'"),
        nativeHelpNodes(cli),
      ),
    ).toEqual([expect.objectContaining({ reason: "unknown-flag", line: 4 })]);
  });

  it("keeps portable prose commands resolvable against the native registry", () => {
    const nodes = nativeHelpNodes(cli);
    const findings = skillDocumentPaths().flatMap((file) =>
      proseUsageFindings(readFileSync(file, "utf8"), nodes).map(
        (finding) =>
          `${file}:${finding.line}: ${finding.text} (${finding.reason})`,
      ),
    );
    expect(findings).toEqual([]);
  });
});

describe("generated markers", () => {
  const source = `intro\n${BEGIN_MARKER}\nOLD\n${END_MARKER}\noutro\n`;
  it("replaces only the declared block and round-trips", () => {
    const next = spliceBlock(source, BEGIN_MARKER, END_MARKER, "NEW\n");
    expect(next).toBe(`intro\n${BEGIN_MARKER}\nNEW\n\n${END_MARKER}\noutro\n`);
    expect(extractBlock(next, BEGIN_MARKER, END_MARKER)).toBe("NEW");
  });
  it("rejects absent or reversed markers", () => {
    expect(() =>
      spliceBlock("absent", BEGIN_MARKER, END_MARKER, "new"),
    ).toThrow(/marker/);
    expect(() =>
      spliceBlock(
        `${END_MARKER}\n${BEGIN_MARKER}`,
        BEGIN_MARKER,
        END_MARKER,
        "new",
      ),
    ).toThrow(/order/);
  });
});
