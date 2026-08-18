import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cctlCommandMentions,
  lineLeadingLabels,
  readCliSources,
  stringLiterals,
} from "./source-scan";

const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The scanner the CLI's convention ratchets share. It is tested against crafted
 * sources rather than only against the tree it sweeps: a sweep over clean code
 * passes whether or not the scanner sees anything, so the proof that a ratchet
 * can fail lives here.
 */
describe("cli source scan", () => {
  it("reads literals and ignores the comments around them", () => {
    const source = [
      "// hint: this line is a comment, not output",
      "/* note: neither is this */",
      'const message = "hint: run `cctl doctor`";',
      'const url = "https://example.test/api";',
    ].join("\n");

    expect(stringLiterals(source)).toEqual([
      "hint: run `cctl doctor`",
      "https://example.test/api",
    ]);
  });

  it("renders an interpolation as an opaque marker, including a nested literal", () => {
    const source =
      "const line = `next: cctl spec show ${slug ?? `${fallback}`} --full`;";

    expect(stringLiterals(source)).toEqual(["next: cctl spec show ${} --full"]);
  });

  it("keeps an escaped newline as the line break an agent reads", () => {
    const source = 'const body = "first\\nreminder: keep payloads under .cc/";';

    expect(lineLeadingLabels(stringLiterals(source)[0] ?? "")).toEqual([
      "reminder",
    ]);
  });

  it("labels only what opens a line — indented detail is not a prefix", () => {
    const literal = [
      "hint: do the thing",
      "  cursor: 42",
      "next: cctl dev list",
    ].join("\n");

    expect(lineLeadingLabels(literal)).toEqual(["hint", "next"]);
  });

  it("stops a command mention at the first token that cannot be a path segment", () => {
    expect(
      cctlCommandMentions(
        "run `cctl workflow live get exec-7 --full` to see it",
      ),
    ).toEqual([["workflow", "live", "get", "exec-7"]]);
    expect(cctlCommandMentions("cctl spec show <slug>")).toEqual([
      ["spec", "show"],
    ]);
    expect(cctlCommandMentions("cctl ${verb} status")).toEqual([]);
    expect(cctlCommandMentions("no command here")).toEqual([]);
  });

  it("walks the CLI tree without reading its tests", async () => {
    const sources = await readCliSources(CLI_ROOT);
    const paths = sources.map((file) => file.relativePath);

    expect(paths).toContain("shared.ts");
    expect(paths).toContain("commands/workflow.ts");
    expect(paths).toContain("commands/spec/read.ts");
    expect(paths.filter((file) => file.includes(".test."))).toEqual([]);
  });
});
