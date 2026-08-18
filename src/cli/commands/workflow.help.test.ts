import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workflowLiveEditRequestSchema } from "@/lib/workflows/edit-schemas";
import { classifyCliCommand } from "../session-env-inventory";
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

describe("one-off execution help contract", () => {
  function entry(command: string) {
    return workflowHelpEntries.find(
      (candidate) => candidate.path.join(" ") === command,
    );
  }

  it("registers run, wait, by-id status, and abandon with their parser flags", () => {
    expect(entry("workflow run")?.flags.map((flag) => flag.name)).toEqual([
      "file",
      "inputs",
      "wait",
      "timeout",
    ]);
    expect(entry("workflow wait")?.flags.map((flag) => flag.name)).toEqual([
      "cursor",
      "timeout",
    ]);
    expect(entry("workflow status")?.flags.map((flag) => flag.name)).toEqual([
      "halt",
      "full",
    ]);
    expect(entry("workflow status")?.usage).toContain(
      "cctl workflow status [<executionId>] [--halt | --full] [--json]",
    );
    expect(entry("workflow abandon")?.flags.map((flag) => flag.name)).toEqual([
      "reason",
    ]);
  });

  it("keeps launch and observation discoverable in both directions", () => {
    expect(
      entry("workflow run")?.related.map((related) => related.command),
    ).toContain("workflow wait");
    expect(
      entry("workflow wait")?.related.map((related) => related.command),
    ).toContain("workflow run");
    expect(
      entry("workflow status")?.related.map((related) => related.command),
    ).toContain("workflow wait");
  });

  it("inherits the workflow group's deliberate session-only scope", () => {
    for (const command of [
      "workflow run",
      "workflow wait",
      "workflow status",
      "workflow abandon",
    ]) {
      expect(classifyCliCommand(command)?.support, command).toBe(
        "session-only",
      );
    }
  });

  it("removes release from every workflow help and usage surface", () => {
    expect(entry("workflow abandon")).toBeDefined();
    expect(entry("workflow live release")).toBeUndefined();
    expect(JSON.stringify(workflowHelpEntries)).not.toMatch(
      /workflow live release|live release/,
    );
  });
});
