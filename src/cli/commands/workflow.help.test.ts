import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workflowLiveEditRequestSchema } from "@/lib/workflows/edit-schemas";
import { workflowHelpEntries } from "./workflow.help";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("workflow live-edit assignment help", () => {
  it("ships an example that the current live-edit request schema accepts", () => {
    const entry = workflowHelpEntries.find(
      (candidate) => candidate.path.join(" ") === "workflow live edit",
    );
    const explanation = entry?.examples[0]?.explanation ?? "";
    const match = explanation.match(
      /live-ops\.json under \.cc\/temp\/: (\{.*\}) — take baseLiveRevision/s,
    );

    expect(match?.[1], "the live-edit help example JSON").toBeDefined();
    expect(
      workflowLiveEditRequestSchema.safeParse(JSON.parse(match?.[1] ?? "{}"))
        .success,
    ).toBe(true);
  });

  it("keeps the shipped cc-cli skill on the same profile-bearing assignment shape", () => {
    const skill = readFileSync(
      path.join(
        REPO_ROOT,
        "plugins/command-center/command-center/skills/cc-cli/SKILL.md",
      ),
      "utf8",
    );

    expect(skill).toContain(
      '"profile": { "tier": "builtin", "id": "general-implementer" }',
    );
    expect(skill).not.toContain(
      '"implementer": { "backend": "claude", "model": "opus", "reasoningEffort": "high" }',
    );
  });
});
