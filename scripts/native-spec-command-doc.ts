#!/usr/bin/env bun
/**
 * Generate the guidance block of `.claude/commands/spec.md` from the native spec
 * guidance module (`src/lib/conversation-commands/native-spec-guidance.ts`).
 *
 * That module is the single source for two surfaces: the runtime `/spec`
 * expansion an agent receives on a CC-driven turn, and this repository command
 * document. Hand-syncing the second one is what let the two drift apart while
 * both of their tests stayed green, so the block between the markers is rendered
 * from the module and CI (`--check`) fails when the committed document differs
 * from what the module would produce.
 *
 * Scope: this generates ONLY the marked block. The frontmatter that
 * `discoverCommands` reads, and the `$ARGUMENTS` intro, stay hand-authored —
 * they are command-document mechanics with no runtime equivalent.
 *
 * Usage:
 *   bun scripts/native-spec-command-doc.ts           # rewrite the block in place
 *   bun scripts/native-spec-command-doc.ts --check   # CI gate: read-only; non-zero
 *                                                    # exit if the document is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderSpecCommandGuidance,
  spliceSpecCommandGuidance,
} from "../src/lib/conversation-commands/native-spec-guidance";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
export const SPEC_COMMAND_DOC_PATH = path.join(
  repoRoot,
  ".claude/commands/spec.md",
);

/**
 * The whole document the generator would write for `source`. Pure — takes the
 * committed text, returns the regenerated text — so the drift gate compares
 * complete files rather than only the block, and stray edits around the markers
 * are caught too. Throws when `source` declares no generated block.
 */
export function renderSpecCommandDoc(source: string): string {
  return spliceSpecCommandGuidance(source, renderSpecCommandGuidance());
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const source = readFileSync(SPEC_COMMAND_DOC_PATH, "utf8");
  const next = renderSpecCommandDoc(source);
  const relativePath = path.relative(repoRoot, SPEC_COMMAND_DOC_PATH);

  if (checkMode) {
    if (next !== source) {
      console.error(
        `${relativePath} is stale — the native spec guidance changed.\n` +
          "Regenerate it with `bun scripts/native-spec-command-doc.ts` and commit the result.",
      );
      process.exit(1);
    }
    console.log(`${relativePath} is up to date.`);
    return;
  }

  if (next === source) {
    console.log(`${relativePath} already up to date.`);
    return;
  }
  writeFileSync(SPEC_COMMAND_DOC_PATH, next);
  console.log(`Wrote the shared spec guidance into ${relativePath}.`);
}

if (import.meta.main) {
  main();
}
