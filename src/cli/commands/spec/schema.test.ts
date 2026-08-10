import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createSpecInitialElementSchema,
  draftElementBatchDocumentSchema,
  draftElementDocumentSchema,
} from "@/lib/specs/authoring-service";
import {
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  specElementKindSchema,
  taskElementPayloadSchema,
  touchedPathSchema,
  validationStrategySchema,
} from "@/lib/specs/schemas";
import { NATIVE_SDD_GUIDANCE } from "@/lib/specs/native-sdd-guidance";
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
  it("publishes active authoring, capture, and delivery-plan inputs", async () => {
    const documents = await readDocuments();

    expect(documents.map((document) => document.id)).toEqual([
      ...specElementKindSchema.options,
      "element-batch",
      "element-batch-removals",
      "create-element",
      "discovered-task",
      "plan-edit",
      "guidance",
    ]);
  });

  it("publishes the materializer, lint, and evidence registries as one offline guidance document", async () => {
    const documents = await readDocuments();
    const guidance = documents.find(({ id }) => id === "guidance");
    const reference = z
      .object({
        materializerFieldMappings: z.array(
          z.object({
            source: z.string(),
            target: z.string(),
            transformation: z.string(),
          }),
        ),
        lintTaxonomy: z.object({
          evergreen: z.array(
            z.object({ ruleId: z.string(), severity: z.string() }),
          ),
          deliveryPlan: z.array(
            z.object({ ruleId: z.string(), severity: z.string() }),
          ),
        }),
        evidenceProducers: z.array(
          z.object({
            kind: z.string(),
            sourceEvent: z.string(),
            requiresStrategyDeclaration: z.boolean(),
            detail: z.string(),
          }),
        ),
      })
      .parse(guidance?.example);

    expect(reference).toEqual(NATIVE_SDD_GUIDANCE);

    expect(reference.materializerFieldMappings).toContainEqual({
      source: "contexts[].contextId",
      target: "executionContexts[].id",
      transformation: "copy",
    });
    expect(reference.lintTaxonomy.evergreen).toContainEqual({
      ruleId: "9.7.claim-without-evidence",
      severity: "blocks_claim",
    });
    expect(reference.lintTaxonomy.deliveryPlan).toContainEqual({
      ruleId: "plan/selected-multi-owned",
      severity: "blocks_propose",
    });
    const validatorVerdict = reference.evidenceProducers.find(
      ({ kind }) => kind === "validator_verdict",
    );
    const testRun = reference.evidenceProducers.find(
      ({ kind }) => kind === "test_run",
    );
    expect(testRun).toMatchObject({
      sourceEvent: "graph-workflow-validation-result",
      requiresStrategyDeclaration: true,
    });
    expect(validatorVerdict?.sourceEvent).toBe(testRun?.sourceEvent);
    expect(testRun?.detail).toContain("same validation event");
  });

  /**
   * Removal existed server-side and was invisible from every published shape,
   * which is exactly why nothing reached it. The document is what makes it
   * discoverable without reading `src/lib/specs`.
   */
  it("publishes the removal batch as a keyed document the server itself parses", async () => {
    const documents = await readDocuments();
    const batch = documents.find(({ id }) => id === "element-batch-removals");

    expect(batch?.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        removals: {
          type: "array",
          items: {
            type: "object",
            required: ["elementId", "baseElementVersion"],
          },
        },
      },
    });
    // The worked example must be authorable as-is against the accepting
    // schema, removals included.
    const parsed = draftElementBatchDocumentSchema.safeParse(batch?.example);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(batch?.usedBy).toEqual([
      "cctl spec draft <slug> --file <batch.json>",
      "cctl spec remove <slug> <handle...>",
    ]);
    expect(batch?.notes.join(" ")).toContain("ONE transaction");
  });

  /**
   * The draft document and the create document are different shapes, and one
   * document claiming both verbs is what made a draft file carrying the
   * compare-and-swap version fail as an unrecognized key while every batch
   * element required it. Each published document names exactly the invocations
   * that accept it.
   */
  it("publishes the draft and create element documents as distinct shapes", async () => {
    const documents = await readDocuments();

    for (const kind of specElementKindSchema.options) {
      const draft = documents.find(({ id }) => id === kind);
      expect(
        draft?.usedBy,
        `${kind}: draft document names the wrong verbs`,
      ).toEqual([
        "cctl spec draft <slug> --file <element.json>",
        "cctl spec draft <slug> --file <elements.json>",
      ]);
      // The draft document requires the version, and its example states one.
      expect(draft?.jsonSchema).toMatchObject({
        required: [
          "elementId",
          "kind",
          "parentElementId",
          "payload",
          "baseElementVersion",
        ],
      });
      const parsedDraft = draftElementDocumentSchema.safeParse(draft?.example);
      expect(
        parsedDraft.success ? null : { kind, issues: parsedDraft.error.issues },
      ).toBeNull();
    }

    const create = documents.find(({ id }) => id === "create-element");
    expect(create?.usedBy).toEqual([
      "cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>",
    ]);
    // The create document has no version to compare against, and states none.
    expect(
      createSpecInitialElementSchema.safeParse(create?.example).success,
    ).toBe(true);
    expect(
      createSpecInitialElementSchema.safeParse({
        ...z.record(z.string(), z.unknown()).parse(create?.example),
        baseElementVersion: null,
      }).success,
    ).toBe(false);
    expect(create?.notes.join(" ")).toContain("no baseElementVersion");
  });

  /**
   * `spec create` opens an amendment when the slug already exists with no
   * draft, so the marker does belong here — but the document states no base
   * version, and telling an author to pair it with one names a field this
   * document rejects.
   */
  it("states the reintroduction marker without a base version to pair it with", async () => {
    const documents = await readDocuments();
    const create = documents.find(({ id }) => id === "create-element");
    const notes = create?.notes.join(" ") ?? "";

    expect(notes).toContain("reintroduceHistorical");
    expect(notes).toContain("historical_element_id");
    expect(notes).not.toContain("pair it with a null base version");
    // The marker is a real field of this document, not prose about another.
    expect(
      createSpecInitialElementSchema.safeParse({
        ...z.record(z.string(), z.unknown()).parse(create?.example),
        reintroduceHistorical: true,
      }).success,
    ).toBe(true);
  });

  /**
   * Element versions are revision-local: an amendment copies the approved
   * content in at version 1. A document that teaches the compare-and-swap
   * without that fact teaches an author to reuse a version the new revision
   * never had.
   */
  it("states that element versions restart at 1 in a new revision", async () => {
    const documents = await readDocuments();

    for (const id of [...specElementKindSchema.options, "element-batch"]) {
      const notes = (
        documents.find((document) => document.id === id)?.notes ?? []
      )
        .join(" ")
        .toLowerCase();
      expect(notes, `${id}: no revision-local version statement`).toContain(
        "restart at 1",
      );
      expect(notes, `${id}: does not name the amend re-read`).toContain(
        "re-read the element after an amendment",
      );
    }
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
      .array(draftElementDocumentSchema)
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

  /**
   * The flag is gone: the version travels in the document. A published note
   * still naming it would send an author at a flag every form now refuses.
   */
  it("never points an author at the removed --base-version flag", async () => {
    const documents = await readDocuments();

    for (const document of documents) {
      expect(
        [...document.notes, ...document.usedBy].filter((line) =>
          line.includes("--base-version"),
        ),
        `${document.id} still names --base-version`,
      ).toEqual([]);
    }
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
      required: [
        "elementId",
        "kind",
        "parentElementId",
        "payload",
        "baseElementVersion",
      ],
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

  /**
   * `touchedPathSchema`'s normalization is a `.superRefine()`, which
   * `z.toJSONSchema` drops: an author reading the published task document sees
   * a bare string array and writes `src/cli/` or an absolute path, which the
   * server then refuses. The published node has to carry the rule in prose,
   * and the worked example has to show the shape the rule accepts.
   */
  it("publishes the touched-path normalization rule the server enforces", async () => {
    const documents = await readDocuments();
    const task = documents.find(({ id }) => id === "task");
    const touchedPathsNode = z
      .object({
        properties: z.object({
          payload: z.object({
            properties: z.object({
              touchedPaths: z.object({
                items: z.record(z.string(), z.unknown()),
              }),
            }),
          }),
        }),
      })
      .loose()
      .parse(task?.jsonSchema).properties.payload.properties.touchedPaths.items;

    expect(touchedPathsNode).toMatchObject({
      type: "string",
      description:
        "normalized repo-relative POSIX paths; directories without a trailing slash",
    });
    // The example is the only shape an author copies, so it must be the
    // directory form the refinement accepts — a trailing slash is refused.
    const touchedPaths = z
      .object({ payload: z.object({ touchedPaths: z.array(z.string()) }) })
      .loose()
      .parse(task?.example).payload.touchedPaths;
    expect(touchedPaths).toEqual(["src/cli/commands/spec"]);
    for (const path of touchedPaths) {
      expect(touchedPathSchema.safeParse(path).success).toBe(true);
      expect(touchedPathSchema.safeParse(`${path}/`).success).toBe(false);
    }
  });

  it("ships a worked example that the server's own input schema accepts", async () => {
    const documents = await readDocuments();

    for (const kind of specElementKindSchema.options) {
      const document = documents.find(({ id }) => id === kind);
      const parsed = draftElementDocumentSchema.safeParse(document?.example);
      expect(
        parsed.success ? null : { kind, issues: parsed.error.issues },
      ).toBeNull();
    }
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
    expect(
      documents.find((document) => document.id === "task")?.notes.join(" "),
    ).toMatch(/legacy-only.*spec schema plan-edit/i);
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

  it("documents the reintroduction marker on every element write document", async () => {
    const documents = await readDocuments();

    for (const id of [...specElementKindSchema.options, "element-batch"]) {
      const document = documents.find((candidate) => candidate.id === id);
      const notes = (document?.notes ?? []).join(" ");
      expect(notes).toContain("reintroduceHistorical");
      // The marker is only reachable from the refusal that asks for it, so the
      // note has to name that refusal.
      expect(notes).toContain("historical_element_id");
      expect(notes.toLowerCase()).toContain("keeps its number and handle");
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
    expect(result.stderr).not.toContain("cctl spec schema scope");
  });

  it("refuses the retired execution-scope document and points at plan editing", async () => {
    const result = await runCli(
      ["spec", "schema", "scope"],
      env,
      offlineHost(),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown schema document "scope"');
    expect(result.stderr).toContain("cctl spec schema plan-edit");
    expect(result.stderr).not.toContain("spec start <slug> --file");
  });
});
