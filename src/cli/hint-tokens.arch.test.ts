import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allHelpEntries,
  buildHelpRegistry,
  childHelpEntries,
  resolveHelpEntry,
} from "./help-registry";
import { pathKey, type CommandHelpEntry } from "./help-types";
import {
  cctlCommandMentions,
  readCliSources,
  stringLiterals,
  type CliSourceFile,
} from "./testing/source-scan";

const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".",
);

const REGISTRY = buildHelpRegistry(allHelpEntries());

/**
 * `workflow execution …` / `workflow exec …` are dispatch-rewrite aliases for
 * `workflow live …` and carry no registry entries of their own, so a mention
 * spelling them resolves the same node the dispatcher would.
 */
function rewriteAliases(tokens: readonly string[]): string[] {
  if (
    tokens[0] === "workflow" &&
    (tokens[1] === "execution" || tokens[1] === "exec")
  ) {
    return ["workflow", "live", ...tokens.slice(2)];
  }
  return [...tokens];
}

function entryFor(tokens: readonly string[]): CommandHelpEntry | undefined {
  const entry = resolveHelpEntry(REGISTRY, [...tokens]);
  return entry !== undefined && entry.path.length === tokens.length
    ? entry
    : undefined;
}

/**
 * The unresolvable command path a mention names, or null when it resolves.
 *
 * Two tolerances keep the sweep lexical rather than speculative. A first token
 * that is not a top-level command is prose about the binary ("this cctl is
 * build …"), not an invocation. And walking stops at a LEAF, because everything
 * after a leaf is an argument — `cctl spec show native-sdd` names a slug, not a
 * subcommand. What is left is the defect the sweep exists for: a guidance line
 * naming a verb under a live group that the registry no longer has.
 */
function unresolvedPath(mention: readonly string[]): string | null {
  const tokens = rewriteAliases(mention);
  const head = tokens[0];
  if (head === undefined) return null;
  let entry = entryFor([head]);
  if (entry === undefined) return null;

  for (let depth = 2; depth <= tokens.length; depth++) {
    const candidate = tokens.slice(0, depth);
    const deeper = entryFor(candidate);
    if (deeper !== undefined) {
      entry = deeper;
      continue;
    }
    const isGroup = childHelpEntries(REGISTRY, entry.path).length > 0;
    return isGroup ? candidate.join(" ") : null;
  }
  return null;
}

function unresolvedMentions(
  sources: readonly CliSourceFile[],
): { site: string; command: string }[] {
  const found: { site: string; command: string }[] = [];
  for (const file of sources) {
    for (const literal of stringLiterals(file.source)) {
      for (const mention of cctlCommandMentions(literal)) {
        const unresolved = unresolvedPath(mention);
        if (unresolved !== null) {
          found.push({ site: file.relativePath, command: unresolved });
        }
      }
    }
  }
  return found;
}

/**
 * The hint-token ratchet (docs/design/cc-cli/09 §3, §10). Guidance is only
 * useful if the command it names exists: a hint pointing at a retired verb is
 * worse than no hint, because the agent runs it and gets a usage failure it
 * cannot act on. Renaming a verb now breaks this sweep in the same change.
 */
describe("commands named in CLI text resolve against the registry", () => {
  it("names no retired command", async () => {
    const unresolved = unresolvedMentions(await readCliSources(CLI_ROOT));

    const reported = [
      ...new Set(unresolved.map((hit) => `${hit.site}: "cctl ${hit.command}"`)),
    ].sort();
    expect(
      reported,
      "these lines name a command the help registry does not have — fix the text, or add the entry the text promises",
    ).toEqual([]);
  });

  it("catches a verb that the registry no longer has", () => {
    const hits = unresolvedMentions([
      {
        relativePath: "commands/new-command.ts",
        source: [
          'const gone = "hint: run `cctl workflow rewind exec-7` to undo it";',
          'const live = "hint: run `cctl workflow live get exec-7 --full`";',
          'const prose = "this cctl is build ${x}";',
          'const arg = "next: cctl spec show native-sdd";',
        ].join("\n"),
      },
    ]);

    expect(hits.map((hit) => hit.command)).toEqual(["workflow rewind"]);
  });

  it("resolves the workflow live aliases the dispatcher rewrites", () => {
    expect(unresolvedPath(["workflow", "execution", "get"])).toBeNull();
    expect(unresolvedPath(["workflow", "exec", "get"])).toBeNull();
    expect(unresolvedPath(["workflow", "execution", "rewind"])).toBe(
      "workflow live rewind",
    );
  });

  it("reads a real command path out of the registry it checks against", () => {
    // Guards the tolerance itself: if `entryFor` stopped resolving exact paths,
    // every mention would silently "resolve" and the sweep would prove nothing.
    expect(entryFor(["workflow", "live", "get"])?.path).toEqual([
      "workflow",
      "live",
      "get",
    ]);
    expect(entryFor(["workflow", "live", "nope"])).toBeUndefined();
    expect(pathKey(["workflow", "live"])).toBe("workflow live");
  });
});
