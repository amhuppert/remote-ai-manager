import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  renderSpecCommandGuidance,
  SPEC_GUIDANCE_BEGIN_MARKER,
  SPEC_GUIDANCE_END_MARKER,
} from "../src/lib/conversation-commands/native-spec-guidance";
import {
  renderSpecCommandDoc,
  SPEC_COMMAND_DOC_PATH,
} from "./native-spec-command-doc";

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
