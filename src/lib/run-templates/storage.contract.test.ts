import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { runTemplateRecordSchema, type RunTemplateRecord } from "./document";
import { createRunTemplateStorage, type RunTemplateScope } from "./storage";

/**
 * Maximal round-trip backstop for stored run templates. Storage is one JSON
 * document per template, so the persistence fixture is a real temp config
 * directory and every reload re-reads the file through the storage service.
 */

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-run-template-contract-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const seat = {
  backend: "codex" as const,
  modelSelection: { modelId: "gpt-5.4", parameters: { effort: "high" } },
};

/** Every introspectable key path carries a distinctive value. */
function buildMaximalRecord(): RunTemplateRecord {
  return {
    format: 1,
    id: "ship-a-fix",
    revision: 1,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    name: "Ship a fix",
    description: "Fix a ticket, then document it",
    parameters: [
      { name: "ticket", description: "Ticket number", required: true },
    ],
    defaults: {
      implementer: {
        profile: { tier: "project", id: "api-writer" },
        ...seat,
      },
      reviewers: [
        {
          authority: "blocking",
          focus: "Correctness",
          profile: { tier: "global", id: "strict-reviewer" },
          ...seat,
        },
      ],
      checks: ["typecheck"],
      humanApproval: true,
      ownerQuestions: false,
      timeoutMs: 600_000,
    },
    workflow: {
      contexts: [
        {
          key: "fix",
          title: "Fix #{{inputs.ticket}}",
          brief: "Fix ticket {{inputs.ticket}}",
          tasks: [
            {
              title: "Reproduce {{inputs.ticket}}",
              instructions: "Write a failing test first",
            },
          ],
          acceptanceCriteria: ["The ticket no longer reproduces"],
          outputSchema: {
            type: "object",
            properties: { fixed: { type: "boolean" } },
          },
          dependsOn: [
            { key: "triage", when: { else: true }, outputOnly: true },
          ],
          routing: { cardinality: "atLeastOne" },
          scope: { mode: "owned", paths: ["src/api"] },
          lane: "api",
          settings: {
            implementer: {
              profile: { tier: "builtin", id: "standard-agent" },
              ...seat,
            },
            reviewers: [
              {
                authority: "advisory",
                focus: "Style",
                profile: { tier: "builtin", id: "general-reviewer" },
                ...seat,
              },
            ],
            checks: ["lint"],
            humanApproval: false,
            ownerQuestions: true,
            timeoutMs: 300_000,
          },
        },
      ],
      loops: [
        {
          key: "polish",
          body: ["fix"],
          entry: "fix",
          exit: "fix",
          until: {
            schema: { type: "object", properties: { done: { const: true } } },
          },
          maxPasses: 3,
        },
      ],
      lanes: [{ key: "api", checks: ["test"] }],
      documents: [
        {
          path: "notes/plan.md",
          from: "docs/plan.md",
          contents: "# Plan",
          description: "The plan",
          readWhen: "Before you start",
          appliesTo: ["fix"],
        },
      ],
      charter: {
        mission: "Close the ticket",
        conventions: ["Name events with dots"],
        nonGoals: ["Refactors"],
        vocabulary: ["ticket"],
        testStrategy: "Regression tests",
        knownAmbiguities: ["Retries"],
        invariants: [
          {
            id: "no-mocks",
            statement: "No internal mocks",
            appliesTo: ["fix"],
          },
        ],
        sourcesOfTruth: [
          {
            rank: 1,
            id: "ticket",
            label: "The ticket",
            type: "other",
            locator: "tickets/42",
            description: "What was reported",
            appliesTo: ["fix"],
          },
        ],
      },
    },
  };
}

/** Storage owns the revision and timestamps; the harness checks the values it wrote. */
const FIELD_POLICIES = {
  revision: "derived-on-write",
  createdAt: "derived-on-write",
  updatedAt: "derived-on-write",
} as const;

const SCOPES: ReadonlyArray<[label: string, scope: RunTemplateScope]> = [
  ["global scope", { kind: "global" }],
  ["project scope", { kind: "project", projectPath: "/durability-project" }],
];

function contentOf(record: RunTemplateRecord) {
  const {
    format: _format,
    id: _id,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...content
  } = record;
  return content;
}

describe("run template storage: persisted-field round trip", () => {
  for (const [label, scope] of SCOPES) {
    it(`survives a create through the ${label}`, async () => {
      const storage = createRunTemplateStorage({
        resolveConfigDir: () => configDir,
      });
      await assertRoundTripDurability({
        label: `run template (${label}, create)`,
        schema: runTemplateRecordSchema,
        buildMaximalFixture: buildMaximalRecord,
        fieldPolicies: FIELD_POLICIES,
        persist: async (fixture) => {
          const written = await storage.create(
            scope,
            fixture.id,
            contentOf(fixture),
          );
          if (!written.ok) throw new Error(written.refusal.message);
          return written.record;
        },
        reload: async (expected) => {
          const read = await storage.get(scope, expected.id);
          return read.kind === "found" ? read.record : null;
        },
      });
    });

    it(`survives a replacement through the ${label}`, async () => {
      const storage = createRunTemplateStorage({
        resolveConfigDir: () => configDir,
      });
      await assertRoundTripDurability({
        label: `run template (${label}, update)`,
        schema: runTemplateRecordSchema,
        buildMaximalFixture: buildMaximalRecord,
        fieldPolicies: FIELD_POLICIES,
        persist: async (fixture) => {
          await storage.create(scope, fixture.id, {
            name: "Placeholder",
            description: "",
            parameters: [],
            defaults: {},
            workflow: { contexts: [{ key: "x", brief: "x" }] },
          });
          const written = await storage.update(
            scope,
            fixture.id,
            1,
            contentOf(fixture),
          );
          if (!written.ok) throw new Error(written.refusal.message);
          return written.record;
        },
        reload: async (expected) => {
          const read = await storage.get(scope, expected.id);
          return read.kind === "found" ? read.record : null;
        },
      });
    });
  }
});
