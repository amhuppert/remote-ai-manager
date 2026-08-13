import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "@/cli/core";
import type { CliHost } from "@/cli/shared";
import { publishManagedSkillBundle } from "@/lib/managed-skills/publisher";

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
  "One-context-provable criteria",
  "Typed integration/closeout ownership",
  "Placement: shared lanes and disjoint ownership",
  "Ranked sources of truth a lane can read",
  "Removal and reintroduction symmetry",
  "Withdraw-proposal vs dismiss-superseded",
  "Element-id/handle/version semantics",
  "Importing a spec authored outside CC",
  "Consistency sweep and `propose --notes` protocol",
  "Finding classes and bounded terminal rounds",
  "Three capture paths",
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
  const result = await runCli([...pathSegments, "--help"], {}, helpHost());
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
    for (const section of EXPECTED_SECTIONS) {
      expect(sectionBody(loadedSkill, section)).toContain(
        section === "Reading specs without flooding context"
          ? READ_ENVELOPE_REFERENCE_COMMAND
          : GENERATED_REFERENCE_COMMAND,
      );
    }
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
      "cctl spec propose <slug> --notes <notes.md>",
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
    expect(capture).toContain("cctl workflow live amend");

    const planOpen = await helpText(["spec", "plan", "open"]);
    expect(planOpen).toContain("spec plan edit");
    const planEdit = await helpText(["spec", "plan", "edit"]);
    expect(planEdit).toContain("spec plan propose");
    const planPropose = await helpText(["spec", "plan", "propose"]);
    expect(planPropose).toContain("spec plan sign-off");
    const planSignOff = await helpText(["spec", "plan", "sign-off"]);
    expect(planSignOff).toContain("spec start");

    const start = await helpText(["spec", "start"]);
    expect(start).toContain("--park");
    expect(start).toContain("spec capture");
    expect(start).toContain("spec abandon");

    const abandon = await helpText(["spec", "abandon"]);
    expect(abandon).toContain("workflow live release");
  });
});
