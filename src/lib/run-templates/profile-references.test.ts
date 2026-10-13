import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import { runTemplateContentSchema } from "./document";
import { createRunTemplateProfileReferences } from "./profile-references";
import {
  createRunTemplateStorage,
  type RunTemplateScope,
  type RunTemplateStorage,
} from "./storage";

const PROJECT_A = "/repos/alpha";
const PROJECT_B = "/repos/beta";
const WRITER: AgentProfileRef = { tier: "project", id: "writer" };
const REVIEWER: AgentProfileRef = { tier: "global", id: "house-reviewer" };

let configDir: string;
let storage: RunTemplateStorage;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-template-refs-"));
  storage = createRunTemplateStorage({ resolveConfigDir: () => configDir });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function save(
  scope: RunTemplateScope,
  id: string,
  content: {
    defaults?: Record<string, unknown>;
    contexts?: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const written = await storage.create(
    scope,
    id,
    runTemplateContentSchema.parse({
      name: `Template ${id}`,
      description: "",
      parameters: [],
      defaults: content.defaults ?? {},
      workflow: {
        contexts: content.contexts ?? [{ key: "work", brief: "Do it" }],
      },
    }),
  );
  if (!written.ok) throw new Error(written.refusal.message);
}

const holders = (projectPath: string | null, ref: AgentProfileRef) =>
  createRunTemplateProfileReferences({ storage }).runTemplateHolders(
    projectPath,
    ref,
  );

describe("run templates that name a profile", () => {
  it("finds a project profile only in its own project's templates", async () => {
    const project = (projectPath: string) =>
      ({ kind: "project", projectPath }) as const;
    await save(project(PROJECT_A), "alpha-fix", {
      defaults: { implementer: { profile: WRITER } },
    });
    // The same qualified id in another project is another profile.
    await save(project(PROJECT_B), "beta-fix", {
      defaults: { implementer: { profile: WRITER } },
    });

    expect(await holders(PROJECT_A, WRITER)).toEqual([
      {
        scope: { kind: "project", projectPath: PROJECT_A },
        id: "alpha-fix",
        name: "Template alpha-fix",
      },
    ]);
  });

  it("finds a global profile in every project's templates and the global ones", async () => {
    const reviewers = {
      reviewers: [{ authority: "blocking", profile: REVIEWER }],
    };
    await save({ kind: "global" }, "shared", { defaults: reviewers });
    await save({ kind: "project", projectPath: PROJECT_A }, "alpha", {
      defaults: reviewers,
    });
    await save({ kind: "project", projectPath: PROJECT_B }, "beta", {
      defaults: reviewers,
    });
    await save({ kind: "project", projectPath: PROJECT_B }, "unrelated", {});

    const found = await holders(PROJECT_A, REVIEWER);

    expect(found.map((holder) => holder.scope)).toEqual(
      expect.arrayContaining([
        { kind: "global" },
        { kind: "project", projectPath: PROJECT_A },
        { kind: "project", projectPath: PROJECT_B },
      ]),
    );
    expect(found.map((holder) => holder.id).sort()).toEqual([
      "alpha",
      "beta",
      "shared",
    ]);
  });

  it("names the defaults without a context, and a context's settings by its key, once per place", async () => {
    await save({ kind: "global" }, "release", {
      defaults: { implementer: { profile: REVIEWER } },
      contexts: [
        { key: "build", brief: "Build it" },
        {
          key: "docs",
          brief: "Document it",
          settings: {
            reviewers: [
              { authority: "blocking", profile: REVIEWER },
              { authority: "advisory", focus: "tone", profile: REVIEWER },
            ],
          },
        },
      ],
    });

    expect(await holders(PROJECT_A, REVIEWER)).toEqual([
      { scope: { kind: "global" }, id: "release", name: "Template release" },
      {
        scope: { kind: "global" },
        id: "release",
        name: "Template release",
        contextId: "docs",
      },
    ]);
    expect(await holders(PROJECT_A, WRITER)).toEqual([]);
  });
});
