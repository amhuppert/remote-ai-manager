import { existsSync, readFileSync } from "node:fs";
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

/**
 * The acknowledgement flag is the only way past the one refusal review
 * machinery can produce, so a refused author who runs `--help` has to find it
 * there — an undocumented escape hatch is a dead end with extra steps.
 */
describe("acknowledgement gate help contract", () => {
  function entry(command: string) {
    return workflowHelpEntries.find(
      (candidate) => candidate.path.join(" ") === command,
    );
  }

  it.each(["workflow create", "workflow replace"])(
    "documents --acknowledge-review on %s with a gate example",
    (command) => {
      const flag = entry(command)?.flags.find(
        (candidate) => candidate.name === "acknowledge-review",
      );
      expect(flag?.kind).toBe("value");
      expect(flag?.kind === "value" ? flag.valuePlaceholder : undefined).toBe(
        "<hash>",
      );
      expect(flag?.description).toMatch(/changes-requested/);

      const examples = entry(command)?.examples ?? [];
      expect(
        examples.some((example) =>
          example.invocation.includes("--acknowledge-review"),
        ),
        `${command} needs one --acknowledge-review example`,
      ).toBe(true);
      expect(
        entry(command)?.usage.some((line) =>
          line.includes("--acknowledge-review"),
        ),
      ).toBe(true);
    },
  );
});

/**
 * The review protocol lives in its own skill, and the planning skill delegates
 * to it rather than restating it. A reviewer who reaches for `--help` on the
 * verb that records the verdict is therefore one hop from the rules unless the
 * entry names that skill itself.
 */
describe("review verb skill routing", () => {
  const entry = workflowHelpEntries.find(
    (candidate) => candidate.path.join(" ") === "workflow review",
  );

  it("routes the reviewer to the reviewer-facing skill", () => {
    expect(
      entry?.skills?.map((skill) => skill.name),
      "workflow review must name the skill that owns the review protocol",
    ).toContain("graph-workflow-review");
  });

  it("keeps the planning skill alongside it as the rubric under review", () => {
    expect(entry?.skills?.map((skill) => skill.name)).toContain(
      "graph-workflow-planning",
    );
  });

  it("declares a skill path that resolves from the repo root", () => {
    const review = entry?.skills?.find(
      (skill) => skill.name === "graph-workflow-review",
    );
    expect(
      existsSync(path.join(REPO_ROOT, review?.path ?? "")),
      `skills path "${review?.path}" does not exist on disk`,
    ).toBe(true);
  });
});
