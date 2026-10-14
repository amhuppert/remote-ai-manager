import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createSpecInitialElementSchema,
  draftElementBatchDocumentSchema,
  draftElementDocumentSchema,
} from "@/lib/specs/authoring-service";
import {
  IMPORTED_VALIDATION_STRATEGY_NOTE,
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  importBundleSchema,
  requirementPrioritySchema,
  sectionRoleSchema,
  specAssumptionDispositionSchema,
  specElementKindSchema,
  validationStrategySchema,
} from "@/lib/specs/schemas";
import {
  artifactTextOf,
  inlineDataOf,
  runCcWithHost,
} from "../../testing/domain-runtime";
import type { CliEnv, CliHost } from "../../transport";

/** Legacy task elements are read-only, so they publish no write document. */
const AUTHORABLE_KINDS = specElementKindSchema.options.filter(
  (kind) => kind !== "task",
);

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
  .object({ documents: z.array(documentSchema) })
  .passthrough();

const indexDocumentSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    usedBy: z.array(z.string().min(1)).min(1),
  })
  .strict();

const indexEnvelopeSchema = z
  .object({ documents: z.array(indexDocumentSchema) })
  .passthrough();

async function readDocuments() {
  const index = await runCcWithHost(
    ["spec", "schema", "--json"],
    env,
    offlineHost(),
  );
  expect(index.exitCode).toBe(0);
  const entries = indexEnvelopeSchema.parse(inlineDataOf(index)).documents;
  const documents = [];
  for (const entry of entries) {
    const result = await runCcWithHost(
      ["spec", "schema", entry.id, "--json"],
      env,
      offlineHost(),
    );
    expect(result.exitCode).toBe(0);
    const [document] = listEnvelopeSchema.parse(
      result.artifacts.length
        ? JSON.parse(artifactTextOf(result)).payload.data
        : inlineDataOf(result),
    ).documents;
    if (document !== undefined) documents.push(document);
  }
  return documents;
}

describe("cctl spec schema", () => {
  it("keeps the schema index limited to document summaries", async () => {
    const result = await runCcWithHost(
      ["spec", "schema", "--json"],
      env,
      offlineHost(),
    );

    expect(result.exitCode).toBe(0);
    const envelope = indexEnvelopeSchema.parse(inlineDataOf(result));
    expect(envelope.documents[0]).not.toHaveProperty("jsonSchema");
    expect(envelope.documents[0]).not.toHaveProperty("example");
  });

  it("publishes the active authoring inputs", async () => {
    const documents = await readDocuments();

    expect(documents.map((document) => document.id)).toEqual([
      ...AUTHORABLE_KINDS,
      "element-batch",
      "element-batch-removals",
      "create-element",
      "import-bundle",
      "guidance",
      "read-envelopes",
    ]);
  });

  it("publishes the spec revision-role semantics offline", async () => {
    const result = await runCcWithHost(
      ["spec", "schema", "read-envelopes", "--json"],
      env,
      offlineHost(),
    );
    expect(result.exitCode).toBe(0);
    const data = result.artifacts.length
      ? JSON.parse(artifactTextOf(result)).payload.data
      : inlineDataOf(result);
    const [document] = listEnvelopeSchema.parse(data).documents;
    expect(document?.jsonSchema).toMatchObject({ type: "object" });
    expect(document?.example).toMatchObject({
      revisionRoles: {
        currentRevision: expect.stringContaining("lineage head"),
        baseRevision: expect.stringContaining("immediate parent"),
        currentApprovedRevision: expect.stringContaining("latest approved"),
      },
    });
  });

  /**
   * The bundle is authored from OUTSIDE this repository — that is the whole
   * point of the verb — so the published document is the only thing standing
   * between an authoring agent and reading `src/lib/specs`.
   */
  it("publishes the import bundle in the index and as a selectable document", async () => {
    const documents = await readDocuments();
    const bundle = documents.find(({ id }) => id === "import-bundle");

    expect(bundle?.usedBy).toEqual([
      "cctl spec import --file <bundle.json>",
      "cctl spec import-preview --file <bundle.json>",
    ]);
    expect(bundle?.jsonSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "slug",
        "name",
        "source",
        "sections",
        "requirements",
        "decisions",
        "questions",
        "assumptions",
      ]),
    });
    // The enums come out of the generated schema, so an author never has to
    // guess a role, priority, risk, or disposition value.
    const enums = Object.fromEntries(
      (bundle?.enums ?? []).map((fact) => [fact.path, fact.values]),
    );
    expect(enums["sections[].role"]).toEqual(sectionRoleSchema.options);
    expect(enums["requirements[].priority"]).toEqual(
      requirementPrioritySchema.options,
    );
    expect(enums["assumptions[].disposition"]).toEqual(
      specAssumptionDispositionSchema.options,
    );

    const notes = bundle?.notes.join(" ") ?? "";
    expect(notes).toContain("ref");
    expect(notes).toContain(IMPORTED_VALIDATION_STRATEGY_NOTE);
    expect(notes).toContain("new specs");

    const text = await runCcWithHost(
      ["spec", "schema", "import-bundle"],
      env,
      offlineHost(),
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('"id": "import-bundle"');
    expect(text.stdout).toContain("cctl spec import --file <bundle.json>");
  });

  /**
   * Mapping an arbitrary external source must need no Command Center source
   * reading, which is only true if the worked example shows every artifact a
   * bundle can carry — including the two that are easiest to omit: a criterion
   * that leans on the imported-strategy default, and a decision whose trace
   * resolves against a bundle-local ref.
   */
  it("works the import example through every artifact a bundle carries", async () => {
    const documents = await readDocuments();
    const bundle = documents.find(({ id }) => id === "import-bundle");

    const parsed = importBundleSchema.safeParse(bundle?.example);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    if (!parsed.success) return;
    const example = parsed.data;

    expect(example.source.label.length).toBeGreaterThan(0);
    expect(example.sections.length).toBeGreaterThan(0);

    const requirement = example.requirements[0];
    expect(requirement?.ref).toBeDefined();
    expect(requirement?.criteria).toHaveLength(2);
    // One criterion states its own obligation; the other leans on the default
    // an import supplies, which is the pair an author has to see to choose.
    expect(
      requirement?.criteria.filter(
        ({ validationStrategy }) => validationStrategy !== undefined,
      ),
    ).toHaveLength(1);
    expect(
      requirement?.criteria.filter(
        ({ validationStrategy }) => validationStrategy === undefined,
      ),
    ).toHaveLength(1);

    const decision = example.decisions[0];
    expect(decision?.rejectedAlternatives.length).toBeGreaterThan(0);
    // The trace resolves inside the bundle: every ref it names is declared.
    const declaredRefs = new Set(
      example.requirements.flatMap(({ ref }) =>
        ref === undefined ? [] : [ref],
      ),
    );
    expect(decision?.traces.length).toBeGreaterThan(0);
    for (const trace of decision?.traces ?? []) {
      expect(declaredRefs.has(trace), `trace "${trace}" is not declared`).toBe(
        true,
      );
    }

    expect(
      example.questions.filter(({ answer }) => answer !== undefined),
    ).toHaveLength(1);
    expect(
      example.assumptions.filter(
        ({ disposition }) => disposition === "confirmed",
      ),
    ).toHaveLength(1);
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
   * The global-uniqueness convention must be readable BEFORE the first write:
   * an abandoned spec still owns its element ids, and learning that only from
   * the element_id_taken refusal cost a live authoring round (#60).
   */
  it("states the slug-prefix element-id convention in every element document", async () => {
    const documents = await readDocuments();
    for (const id of ["requirement", "create-element", "element-batch"]) {
      const document = documents.find((candidate) => candidate.id === id);
      expect(document?.notes.join(" ")).toContain(
        "including abandoned ones — prefix ids with the spec slug",
      );
    }
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

    for (const kind of AUTHORABLE_KINDS) {
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
        required: ["elementId", "kind", "payload", "baseElementVersion"],
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
    // The create document has no version to compare against. An explicit
    // null is tolerated — it states exactly what create means, and refusing
    // it was a guaranteed first-contact stumble for draft-trained callers
    // (#60) — while a NUMBER still refuses: a real base version is a draft
    // document sent at the wrong verb.
    expect(
      createSpecInitialElementSchema.safeParse(create?.example).success,
    ).toBe(true);
    expect(
      createSpecInitialElementSchema.safeParse({
        ...z.record(z.string(), z.unknown()).parse(create?.example),
        baseElementVersion: null,
      }).success,
    ).toBe(true);
    expect(
      createSpecInitialElementSchema.safeParse({
        ...z.record(z.string(), z.unknown()).parse(create?.example),
        baseElementVersion: 3,
      }).success,
    ).toBe(false);
    expect(create?.notes.join(" ")).toContain("baseElementVersion");
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

    for (const id of [...AUTHORABLE_KINDS, "element-batch"]) {
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
        required: ["elementId", "kind", "payload", "baseElementVersion"],
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
   * The generated shape presents parentElementId as an ordinary writable field,
   * and now as an optional one — neither of which says that a create must
   * choose and an update can never change it. An author who learns that from
   * the refusal has already written the document.
   */
  it("states that an element's parent is fixed at creation", async () => {
    const documents = await readDocuments();

    for (const id of [...AUTHORABLE_KINDS, "element-batch", "create-element"]) {
      const notes = (
        documents.find((document) => document.id === id)?.notes ?? []
      ).join(" ");
      expect(notes, `${id}: no parent-immutability statement`).toContain(
        "parentElementId cannot change after creation",
      );
      expect(notes, `${id}: does not say a create must state it`).toContain(
        "A create must state it",
      );
      expect(notes, `${id}: does not say an update may omit it`).toContain(
        "an update may leave it out",
      );
      expect(notes, `${id}: does not name the refusal`).toContain(
        "parent_immutable",
      );
      expect(notes, `${id}: does not name the replacement path`).toContain(
        "cctl spec remove",
      );
    }
  });

  /**
   * Optionality is per verb, not global: the create document is only ever a
   * create, so leaving the parent out there has no ordinary meaning to fall
   * back on and the published shape still demands it.
   */
  it("keeps parentElementId required in the create document alone", async () => {
    const documents = await readDocuments();

    expect(
      documents.find(({ id }) => id === "create-element")?.jsonSchema,
    ).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          required: expect.arrayContaining(["parentElementId"]),
        }),
      ]),
    });
    expect(
      createSpecInitialElementSchema.safeParse({
        elementId: "req-audit",
        kind: "requirement",
        payload: {
          kind: "requirement",
          statement: "A first element states what contains it.",
          priority: "must",
          risk: "high",
        },
      }).success,
    ).toBe(false);
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
      required: ["elementId", "kind", "payload", "baseElementVersion"],
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

  it("ships a worked example that the server's own input schema accepts", async () => {
    const documents = await readDocuments();

    for (const kind of AUTHORABLE_KINDS) {
      const document = documents.find(({ id }) => id === kind);
      const parsed = draftElementDocumentSchema.safeParse(document?.example);
      expect(
        parsed.success ? null : { kind, issues: parsed.error.issues },
      ).toBeNull();
    }
  });

  it("omits the removed plan-edit schema document", async () => {
    const documents = await readDocuments();
    expect(documents.map((document) => document.id)).not.toContain("plan-edit");
    const result = await runCcWithHost(
      ["spec", "schema", "plan-edit"],
      env,
      offlineHost(),
    );
    expect(result.exitCode).toBe(2);
  });

  it("states the earliest authoring stage that admits each element kind", async () => {
    const documents = await readDocuments();
    const stageOf = (id: string) =>
      documents.find((document) => document.id === id)?.admittedFromStage;

    expect(stageOf("requirement")).toBe("requirements");
    expect(stageOf("criterion")).toBe("requirements");
    expect(stageOf("decision")).toBe("design");
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

    for (const kind of AUTHORABLE_KINDS) {
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

    for (const id of [...AUTHORABLE_KINDS, "element-batch"]) {
      const document = documents.find((candidate) => candidate.id === id);
      const notes = (document?.notes ?? []).join(" ");
      expect(notes).toContain("reintroduceHistorical");
      // The marker is only reachable from the refusal that asks for it, so the
      // note has to name that refusal.
      expect(notes).toContain("historical_element_id");
      expect(notes.toLowerCase()).toContain("keeps its number and handle");
    }
  });

  it("prints the selected schema and leaves the index bounded", async () => {
    const selected = await runCcWithHost(
      ["spec", "schema", "requirement"],
      env,
      offlineHost(),
    );
    expect(selected.exitCode).toBe(0);
    expect(selected.stdout).toContain('"jsonSchema"');
    expect(selected.stdout).toContain('"kind": "requirement"');
    const index = await runCcWithHost(["spec", "schema"], env, offlineHost());
    expect(index.exitCode).toBe(0);
    expect(index.stdout).not.toContain('"jsonSchema"');
    for (const id of AUTHORABLE_KINDS)
      expect(index.stdout).toContain(`"id": "${id}"`);
  });

  it("refuses an unknown spec document and names the available documents", async () => {
    const result = await runCcWithHost(
      ["spec", "schema", "requirements"],
      env,
      offlineHost(),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requirements");
    expect(result.stderr).toContain("requirement");
    expect(result.stderr).not.toContain("cctl spec schema scope");
  });
});
