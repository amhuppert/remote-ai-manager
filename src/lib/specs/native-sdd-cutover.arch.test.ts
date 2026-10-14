// @vitest-inputs src/lib/specs/route-handlers.ts src/lib/specs/service-factory.ts src/lib/conversation-commands/native-spec-guidance.ts src/cli/commands/spec/{native-definitions,native-write-definitions,schema-documents}.ts plugins/command-center/command-center/skills/{native-sdd-authoring,sdd-requirements,sdd-design}/**/*.md
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const RETIRED_COMMAND =
  /cctl workflow\b|(?:cctl )?spec (?:plan|start|capture|delta|measures|abandon)\b|cctl agent run\b/;

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(file)
      : entry.name.endsWith(".md")
        ? [file]
        : [];
  });
}

describe("requirements and design authoring cutover", () => {
  it("keeps retired delivery commands out of agent-facing authoring guidance", () => {
    const files = [
      "src/lib/specs/route-handlers.ts",
      "src/lib/specs/service-factory.ts",
      "src/lib/conversation-commands/native-spec-guidance.ts",
      "src/cli/commands/spec/native-definitions.ts",
      "src/cli/commands/spec/native-write-definitions.ts",
      "src/cli/commands/spec/schema-documents.ts",
    ].map((file) => path.join(ROOT, file));
    for (const skill of [
      "native-sdd-authoring",
      "sdd-requirements",
      "sdd-design",
    ]) {
      files.push(
        ...markdownFiles(
          path.join(
            ROOT,
            "plugins/command-center/command-center/skills",
            skill,
          ),
        ),
      );
    }
    const stale = files.filter((file) =>
      RETIRED_COMMAND.test(readFileSync(file, "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
