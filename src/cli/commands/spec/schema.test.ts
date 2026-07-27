import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createSpecInitialElementSchema,
  draftElementBatchItemSchema,
} from "@/lib/specs/authoring-service";
import {
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  specElementKindSchema,
  taskElementPayloadSchema,
  validationStrategySchema,
} from "@/lib/specs/schemas";
import { executionScopeSchema } from "@/lib/specs/scope-validation";
import { runCli } from "../../core";
import type { CliEnv, CliHost } from "../../shared";

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
};

/**
 * `spec schema` publishes documents compiled into the binary, so it must answer
 * with no server at all — the case it exists for is an agent authoring from a
 * repository that is not Command Center. Any request is a contract failure.
 */
function offlineHost(): CliHost {
  return {
    async fetch() {
      throw new Error("spec schema must not reach the network");
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

const documentSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    usedBy: z.array(z.string().min(1)).min(1),
    jsonSchema: z.record(z.string(), z.unknown()),
    enums: z.array(
      z.object({ path: z.string().min(1), values: z.array(z.string()).min(1) }),
    ),
    example: z.unknown(),
    notes: z.array(z.string().min(1)),
    admittedFromStage: z.string().min(1).optional(),
    roleStages: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const listEnvelopeSchema = z
  .object({ ok: z.literal(true), documents: z.array(documentSchema) })
  .passthrough();

async function readDocuments() {
  const result = await runCli(["spec", "schema", "--json"], env, offlineHost());
  expect(result.exitCode).toBe(0);
  return listEnvelopeSchema.parse(JSON.parse(result.stdout)).documents;
}

describe("cctl spec schema", () => {
  it("publishes one document per element kind plus the batch, scope, and capture inputs", async () => {
    const documents = await readDocuments();

    expect(documents.map((document) => document.id)).toEqual([
      ...specElementKindSchema.options,
      "element-batch",
      "scope",
      "discovered-task",
    ]);
  });

  it("publishes the batch document as an array of per-element writes", async () => {
    const documents = await readDocuments();
    const batch = documents.find(({ id }) => id === "element-batch");

    expect(batch?.jsonSchema).toMatchObject({
      type: "array",
      items: {
        type: "object",
        required: [
          "elementId",
          "kind",
          "parentElementId",
          "payload",
          "baseElementVersion",
        ],
      },
    });
    // The worked example must be authorable as-is: the server's own batch item
    // schema is what parses it.
    const parsed = z
      .array(draftElementBatchItemSchema)
      .safeParse(batch?.example);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    // Each element states its own base version — a batch is not a
    // whole-document write.
    expect(
      z
        .array(z.object({ baseElementVersion: z.number().nullable() }))
        .safeParse(batch?.example).success,
    ).toBe(true);
    expect(batch?.notes.join(" ")).toContain("baseElementVersion");
    expect(batch?.usedBy[0]).toBe(
      "cctl spec draft <slug> --file <elements.json>",
    );
  });

  it("never points a batch author at the single-element --base-version flag", async () => {
    const documents = await readDocuments();
    const batch = documents.find(({ id }) => id === "element-batch");

    // Naming the flag to refuse it is the one legitimate mention; anything
    // else instructs the author to pass a flag this form rejects.
    expect(
      (batch?.notes ?? []).filter(
        (note) =>
          note.includes("--base-version") && !note.includes("does not apply"),
      ),
    ).toEqual([]);
  });

  it("emits a JSON Schema narrowed to each element kind's payload", async () => {
    const documents = await readDocuments();
    const criterion = documents.find(({ id }) => id === "criterion");

    expect(criterion?.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        elementId: { type: "string" },
        kind: { const: "criterion" },
        payload: {
          type: "object",
          properties: { kind: { const: "criterion" } },
          required: ["kind", "text", "validationStrategy"],
        },
      },
      required: ["elementId", "kind", "parentElementId", "payload"],
      additionalProperties: false,
    });
  });

  it("enumerates every enum the element write document carries", async () => {
    const documents = await readDocuments();
    const enumsFor = (id: string) =>
      new Map(
        (documents.find((document) => document.id === id)?.enums ?? []).map(
          (entry) => [entry.path, entry.values],
        ),
      );

    expect(enumsFor("section").get("payload.role")).toEqual([
      "intent_problem",
      "intent_outcomes",
      "intent_non_goals",
      "intent_success_measures",
      "intent_constraints",
      "design_narrative",
      "context",
    ]);
    expect(enumsFor("requirement").get("payload.priority")).toEqual([
      "must",
      "should",
      "could",
    ]);
    expect(enumsFor("requirement").get("payload.risk")).toEqual([
      "high",
      "medium",
      "low",
    ]);
    expect(
      enumsFor("criterion").get("payload.validationStrategy.kinds[]"),
    ).toEqual(["commit", "test_run", "validator_verdict"]);
    expect(
      enumsFor("scope").get("exclusionDispositions[].disposition"),
    ).toEqual(["deferred", "waived", "delivered_elsewhere"]);
  });

  it("publishes the machine-kind invariant the server's criterion schema enforces", async () => {
    const documents = await readDocuments();
    const criterion = documents.find(({ id }) => id === "criterion");
    const kindsNode = z
      .object({
        properties: z.object({
          payload: z.object({
            properties: z.object({
              validationStrategy: z.object({
                properties: z.object({
                  kinds: z.record(z.string(), z.unknown()),
                }),
              }),
            }),
          }),
        }),
      })
      .loose()
      .parse(criterion?.jsonSchema).properties.payload.properties
      .validationStrategy.properties.kinds;

    // The server's .refine() is not expressible by plain z.toJSONSchema, so
    // the published schema must carry the equivalent JSON Schema constraint —
    // otherwise an agent following it authors documents the server rejects.
    expect(kindsNode).toMatchObject({
      type: "array",
      contains: { enum: [...MACHINE_VALIDATION_EVIDENCE_KINDS] },
      minContains: 1,
    });
    // The published constraint and the server refusal come from the same
    // constant: empty and commit-only lists violate both; a machine kind
    // satisfies both.
    expect(validationStrategySchema.safeParse({ kinds: [] }).success).toBe(
      false,
    );
    expect(
      validationStrategySchema.safeParse({ kinds: ["commit"] }).success,
    ).toBe(false);
    for (const kind of MACHINE_VALIDATION_EVIDENCE_KINDS) {
      expect(
        validationStrategySchema.safeParse({ kinds: ["commit", kind] }).success,
      ).toBe(true);
    }
    // A human note states the invariant alongside the machine constraint.
    expect(criterion?.notes.join(" ")).toContain(
      MACHINE_VALIDATION_EVIDENCE_KINDS.join(" or "),
    );
  });

  it("ships a worked example that the server's own input schema accepts", async () => {
    const documents = await readDocuments();

    for (const kind of specElementKindSchema.options) {
      const document = documents.find(({ id }) => id === kind);
      const parsed = createSpecInitialElementSchema.safeParse(
        document?.example,
      );
      expect(
        parsed.success ? null : { kind, issues: parsed.error.issues },
      ).toBeNull();
    }
    expect(
      executionScopeSchema.safeParse(
        documents.find(({ id }) => id === "scope")?.example,
      ).success,
    ).toBe(true);
    expect(
      taskElementPayloadSchema
        .omit({ kind: true })
        .safeParse(
          documents.find(({ id }) => id === "discovered-task")?.example,
        ).success,
    ).toBe(true);
  });

  it("states the earliest authoring stage that admits each element kind", async () => {
    const documents = await readDocuments();
    const stageOf = (id: string) =>
      documents.find((document) => document.id === id)?.admittedFromStage;

    expect(stageOf("requirement")).toBe("requirements");
    expect(stageOf("criterion")).toBe("requirements");
    expect(stageOf("decision")).toBe("design");
    expect(stageOf("task")).toBe("plan");
    // A section's stage depends on its role, so the per-role answer is what a
    // caller can act on; a single stage would be a lie for design_narrative.
    expect(stageOf("section")).toBe("requirements");
    expect(
      documents.find(({ id }) => id === "section")?.roleStages,
    ).toMatchObject({
      design_narrative: "design",
      intent_problem: "requirements",
    });
  });

  it("documents the position ordering contract on every element write document", async () => {
    const documents = await readDocuments();

    for (const kind of specElementKindSchema.options) {
      const notes = (documents.find(({ id }) => id === kind)?.notes ?? [])
        .join(" ")
        .toLowerCase();
      expect(notes).toContain(
        "one global order per revision, sorted by position then elementid",
      );
      expect(notes).toContain("omit position on create to append");
      expect(notes).toContain("nesting comes from parentelementid alone");
      expect(notes).toContain("duplicate positions are accepted");
    }
  });

  it("prints one document's schema, enums, and example in text mode", async () => {
    const result = await runCli(
      ["spec", "schema", "requirement"],
      env,
      offlineHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("document: requirement");
    expect(result.stdout).toContain("used by: cctl spec draft <slug> --file");
    expect(result.stdout).toContain("json schema:");
    expect(result.stdout).toContain("enums:");
    expect(result.stdout).toContain("payload.priority: must | should | could");
    expect(result.stdout).toContain("example:");
    expect(result.stdout).toContain('"kind": "requirement"');
  });

  it("indexes every document without dumping them when no kind is named", async () => {
    const result = await runCli(["spec", "schema"], env, offlineHost());

    expect(result.exitCode).toBe(0);
    for (const id of [
      ...specElementKindSchema.options,
      "element-batch",
      "scope",
      "discovered-task",
    ]) {
      expect(result.stdout).toContain(`cctl spec schema ${id}`);
    }
    expect(result.stdout).not.toContain("json schema:");
  });

  it("refuses an unknown document at exit 2 and names the ones it has", async () => {
    const result = await runCli(
      ["spec", "schema", "requirements"],
      env,
      offlineHost(),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requirements");
    expect(result.stderr).toContain("requirement");
    expect(result.stderr).toContain("scope");
  });
});
