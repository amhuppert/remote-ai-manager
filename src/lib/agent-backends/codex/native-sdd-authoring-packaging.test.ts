// @vitest-inputs plugins/command-center/** .kiro/steering/**/*.md
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCcWithHost } from "@/cli/testing/domain-runtime";
import type { CliHost } from "@/cli/transport";
import { publishManagedSkillBundle } from "@/lib/managed-skills/publisher";
import {
  NATIVE_SDD_CLAIMS_SOURCE_ID,
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
} from "@/lib/specs/delivery-plan";

import { ensureCodexManagedSkillsBridge } from "./managed-skills-bridge";

const execFileAsync = promisify(execFile);
const SOURCE_PLUGIN_ROOT = path.join(
  process.cwd(),
  "plugins",
  "command-center",
  "command-center",
);
const SKILL_NAME = "native-sdd-authoring";
const GENERATED_REFERENCE_COMMAND = "cctl spec schema guidance";
const READ_ENVELOPE_REFERENCE_COMMAND = "cctl spec schema read-envelopes";
const EXPECTED_SECTIONS = [
  "Reading specs without flooding context",
  "Exclusive Requirements and Design checkpoints",
  "Managed delivery workflow",
  "Stable-source claims and dynamic accountability",
  "Draft review, sign-off, and one-off start",
  "Ordinary live edit, capture, and replacement",
  "Removal and reintroduction symmetry",
  "Correcting obsolete questions and assumptions",
  "Continuous review of the draft",
  "Element-id/handle/version semantics",
  "Importing a spec authored outside CC",
  "Consistency sweep and `propose --notes` protocol",
  "Finding classes and bounded terminal rounds",
  "Designed friction versus a defect",
  "Notify only from success receipts",
] as const;
const STEERING_SEARCH_TERMS = [
  "cctl spec",
  "native SDD",
  "spec authoring",
] as const;
const CONVERTED_STEERING_FILES = [] as const;

async function initializeGitRepository(directory: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: directory });
}

function helpHost(): CliHost {
  return {
    async fetch() {
      throw new Error("portable help must not depend on a CC server");
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

async function helpText(pathSegments: string[]): Promise<string> {
  const result = await runCcWithHost(
    [...pathSegments, "--help"],
    {},
    helpHost(),
  );
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

function sectionBody(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  const rest = markdown.slice(start + marker.length);
  const nextSection = rest.search(/^## /m);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

describe("native-sdd-authoring managed skill", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory === undefined) return;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("publishes, injects, and loads the skill in a non-CC project", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cc-native-sdd-skill-"),
    );
    const configDirectory = path.join(temporaryDirectory, "config");
    const nonCcProject = path.join(temporaryDirectory, "customer-project");
    await mkdir(nonCcProject, { recursive: true });
    await initializeGitRepository(nonCcProject);

    const published = await publishManagedSkillBundle({
      sourceDir: SOURCE_PLUGIN_ROOT,
      configDir: configDirectory,
    });

    expect(published.published).toBe(true);
    if (!published.published) return;
    expect(published.bundle.skillNames).toContain(SKILL_NAME);

    const injection = await ensureCodexManagedSkillsBridge({
      checkoutPath: nonCcProject,
      bundle: published.bundle,
    });
    expect(injection.status).toBe("linked");

    const loadedSkill = await readFile(
      path.join(
        nonCcProject,
        ".agents",
        "skills",
        "command-center",
        SKILL_NAME,
        "SKILL.md",
      ),
      "utf8",
    );
    expect(loadedSkill).toMatch(/^---\nname: native-sdd-authoring\n/);

    const sections = [...loadedSkill.matchAll(/^## (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(sections).toEqual(EXPECTED_SECTIONS);
    expect(
      sectionBody(loadedSkill, "Reading specs without flooding context"),
    ).toContain(READ_ENVELOPE_REFERENCE_COMMAND);
    expect(loadedSkill).toContain(GENERATED_REFERENCE_COMMAND);
    expect(loadedSkill).toContain("cctl spec start <slug> --file");
    expect(loadedSkill).toContain("cctl workflow live edit");
    expect(loadedSkill).toMatch(/destructive cutover/i);
    expect(loadedSkill).toContain("legacy-retirement boundary");
    expect(loadedSkill).toContain(
      "parallel reader, compatibility branch, or alternate plan dialect",
    );
    expect(loadedSkill).not.toMatch(
      /compiler|materializer|context pack|proofPlan|workflow live amend/i,
    );
  });

  /**
   * The reflection attached to command-center#87 is a record of what the skill
   * did not say: the author read a withdrawn revision without knowing reads
   * were current-only, guessed a handle for a section that has none, never
   * found the attention verbs, filed an approval request the propose had
   * already filed, re-litigated approvals a reopen had carried, and reported
   * designed friction as a defect. Each claim below is the sentence that
   * closes one of those, checked on the INJECTED copy because a non-CC agent
   * reads nothing else.
   */
  it("teaches the read contract, propose auto-filing, and the friction taxonomy", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cc-native-sdd-skill-contract-"),
    );
    const configDirectory = path.join(temporaryDirectory, "config");
    const nonCcProject = path.join(temporaryDirectory, "customer-project");
    await mkdir(nonCcProject, { recursive: true });
    await initializeGitRepository(nonCcProject);

    const published = await publishManagedSkillBundle({
      sourceDir: SOURCE_PLUGIN_ROOT,
      configDir: configDirectory,
    });
    expect(published.published).toBe(true);
    if (!published.published) return;
    await ensureCodexManagedSkillsBridge({
      checkoutPath: nonCcProject,
      bundle: published.bundle,
    });
    const skill = await readFile(
      path.join(
        nonCcProject,
        ".agents",
        "skills",
        "command-center",
        SKILL_NAME,
        "SKILL.md",
      ),
      "utf8",
    );

    const reading = sectionBody(
      skill,
      "Reading specs without flooding context",
    );
    expect(reading).toContain("historical_only");
    expect(reading).toContain("--revision");
    expect(reading).toContain("cctl spec section get <slug> --id <element-id>");

    expect(skill).toContain("cctl spec attention edit");
    expect(skill).toContain("cctl spec attention withdraw");
    expect(skill).toContain("cctl spec attention supersede");
    expect(skill).toContain("cctl spec attention cite");
    expect(skill).toContain("cctl spec attention uncite");

    const propose = sectionBody(
      skill,
      "Consistency sweep and `propose --notes` protocol",
    );
    expect(propose).toMatch(/files? the gate-scoped approval request/i);
    expect(propose).toMatch(/cctl spec request-approval[\s\S]{0,120}recovery/i);
    // The prose-lint escape: a literal handle token has to be maskable, or an
    // author who cannot write `R3.2` in prose writes a wrong reference instead.
    expect(propose).toMatch(/backtick|fenced/i);

    const review = sectionBody(skill, "Continuous review of the draft");
    expect(review).toMatch(/only their sign-off freezes the revision/i);
    expect(review).toMatch(/makes it unapproved again/i);
    const identity = sectionBody(skill, "Element-id/handle/version semantics");
    expect(identity).toMatch(/one batch can create an element and cite it/i);
    expect(identity).toContain("parent_immutable");

    const friction = sectionBody(skill, "Designed friction versus a defect");
    expect(friction).toMatch(/human judgment or an audit property/);
    expect(friction).toMatch(/read path|message|missing verb/);

    // #80 design 4: the three constraints this run makes legible. Each row
    // names what it protects and where its reason renders, so an agent that
    // meets one classifies it from the taxonomy instead of a retrospective.
    for (const row of [
      "binding/selected-criterion-not-must-run",
      "requires-pause",
      "region_locked",
    ]) {
      expect(friction, `designed-friction row: ${row}`).toContain(row);
    }
    // The provenance row has to state the merge as well as the lock: an author
    // told only that the fields are locked hand-authors them and is refused.
    expect(friction).toMatch(/replace merges around/iu);
    for (const omitted of [
      "origin",
      "approvalRequired",
      "lockedRegions",
      NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
      NATIVE_SDD_CLAIMS_SOURCE_ID,
    ]) {
      expect(
        friction,
        `the provenance row names ${omitted} among what a plan omits`,
      ).toContain(omitted);
    }

    // The delivery guidance points at its owner rather than carrying a second
    // copy, and `cctl workflow edit` is no longer the authoring path.
    const delivery = sectionBody(skill, "Managed delivery workflow");
    expect(delivery).toContain(
      "../graph-workflow-planning/references/native-spec-delivery.md",
    );
    expect(delivery).toContain("graph-workflow-planning");
    expect(delivery).not.toContain("cctl workflow edit");

    // #80 design 3.8 landed in this run, so the interim rule it earned — pause
    // only once a lane is active — is retired rather than left to outlive the
    // defect it worked around.
    expect(skill).toMatch(/pause is safe at any point after start/iu);
    expect(skill).toContain("cctl spec plan open <slug>");
    expect(skill).not.toMatch(/lane (is )?active/iu);

    // Guidance the reflection proves is harmful: an agent told to hold design
    // work in a question stops authoring, and an assumption disposition is not
    // an act the agent surface performs at all.
    expect(skill).not.toMatch(/park[^.]{0,60}question/i);
    expect(skill).not.toMatch(/reject[^.]{0,30}assumption/i);
    expect(skill).not.toMatch(
      /section handle|handle for a section|<slug>\/<section/i,
    );
  });

  it("keeps the deterministic steering match set converted to thin pointers", async () => {
    const steeringDirectory = path.join(process.cwd(), ".kiro", "steering");
    const markdownFiles = (await readdir(steeringDirectory))
      .filter((fileName) => fileName.endsWith(".md"))
      .sort();
    const matchedFiles: string[] = [];

    for (const fileName of markdownFiles) {
      const content = await readFile(
        path.join(steeringDirectory, fileName),
        "utf8",
      );
      if (STEERING_SEARCH_TERMS.some((term) => content.includes(term))) {
        matchedFiles.push(fileName);
      }
    }

    expect(matchedFiles).toEqual(CONVERTED_STEERING_FILES);
    for (const fileName of CONVERTED_STEERING_FILES) {
      const pointer = await readFile(
        path.join(steeringDirectory, fileName),
        "utf8",
      );
      expect(pointer).toContain("command-center:native-sdd-authoring");
    }
  });

  it("walks the native-SDD loop using only injected skill text and CLI output", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cc-native-sdd-portable-loop-"),
    );
    const configDirectory = path.join(temporaryDirectory, "config");
    const nonCcProject = path.join(temporaryDirectory, "customer-project");
    await mkdir(nonCcProject, { recursive: true });
    await initializeGitRepository(nonCcProject);

    const published = await publishManagedSkillBundle({
      sourceDir: SOURCE_PLUGIN_ROOT,
      configDir: configDirectory,
    });
    expect(published.published).toBe(true);
    if (!published.published) return;
    await ensureCodexManagedSkillsBridge({
      checkoutPath: nonCcProject,
      bundle: published.bundle,
    });

    const skill = await readFile(
      path.join(
        nonCcProject,
        ".agents",
        "skills",
        "command-center",
        SKILL_NAME,
        "SKILL.md",
      ),
      "utf8",
    );
    for (const expected of [
      "cctl spec draft",
      "cctl spec remove",
      "cctl spec lint",
      "cctl spec propose <slug> --notes-file <notes.md>",
    ]) {
      expect(skill).toContain(expected);
    }

    const propose = await helpText(["spec", "propose"]);
    expect(propose).toContain("spec request-approval");

    const requestApproval = await helpText(["spec", "request-approval"]);
    expect(requestApproval).toMatch(/human[\s\S]*sign[- ]off/i);

    const capture = await helpText(["spec", "capture"]);
    expect(capture).toContain("cctl spec plan open");
    expect(capture).toContain("spec abandon");
    expect(capture).toContain("cctl spec plan open");

    const planOpen = await helpText(["spec", "plan", "open"]);
    expect(planOpen).toContain("cctl workflow validate");
    expect(planOpen).toContain("cctl workflow replace");
    const planPropose = await helpText(["spec", "plan", "propose"]);
    expect(planPropose).toContain("signs it off in Builder");
    expect(planPropose).toContain("spec start");

    const start = await helpText(["spec", "start"]);
    expect(start).toContain("--park");
    expect(start).toContain("spec capture");
    expect(start).toContain("spec abandon");

    const abandon = await helpText(["spec", "abandon"]);
    // The backstop a partial abandon receipt names. `workflow live release` was
    // retired with the explicit slot-release act (D7 decision D5): `aborted`
    // frees the lease by itself, so abort is the whole recovery.
    expect(abandon).toContain("workflow live abort");
  });
});
