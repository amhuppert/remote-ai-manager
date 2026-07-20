import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  specAliasSchema,
  specCounterSchema,
  specElementSchema,
  specElementVersionSchema,
  specRevisionSchema,
  specSchema,
  type CriterionElementPayload,
  type RequirementElementPayload,
  type Spec,
  type SpecElementPayload,
} from "@/lib/specs/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  SpecRevisionImmutableError,
  StaleElementConflictError,
  type SpecsRepo,
} from "./specs-repo";

const PROJECT_PATH = "/repos/command-center";
const CREATED_AT = "2026-07-18T10:11:12.000Z";
const UPDATED_AT = "2026-07-18T11:12:13.000Z";
const PROPOSED_AT = "2026-07-18T12:13:14.000Z";
const APPROVED_AT = "2026-07-18T13:14:15.000Z";

let fixture: PersistenceFixture;
let repo: SpecsRepo;
let sequence = 0;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  repo = fixture.specs;
  sequence = 0;
});

afterEach(() => {
  fixture.close();
});

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function requireFixtureString(value: string | null, field: string): string {
  if (value === null) throw new Error(`maximal fixture requires ${field}`);
  return value;
}

async function createSpec(
  overrides: Partial<Pick<Spec, "id" | "slug" | "name">> = {},
) {
  const id = overrides.id ?? nextId("spec");
  return repo.create({
    spec: {
      id,
      projectPath: PROJECT_PATH,
      slug: overrides.slug ?? `spec-${sequence}`,
      name: overrides.name ?? "Native SDD",
      gatePolicy: {
        preset: "contract-bearing",
        overrides: { delivery: "notify" },
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    },
    initialRevision: {
      id: `${id}-revision-1`,
      createdAt: CREATED_AT,
    },
  });
}

function requirementPayload(statement: string): RequirementElementPayload {
  return {
    kind: "requirement",
    statement,
    priority: "must",
    risk: "high",
  };
}

function criterionPayload(text: string): CriterionElementPayload {
  return {
    kind: "criterion",
    text,
    validationStrategy: {
      kinds: ["test_run", "validator_verdict"],
      note: "Run the repository contract tests.",
    },
  };
}

async function addRequirement(
  specId: string,
  revisionId: string,
  statement = "The server enforces every lifecycle gate.",
) {
  return repo.createDraftElement({
    id: nextId("requirement"),
    specId,
    revisionId,
    kind: "requirement",
    parentElementId: null,
    position: 0,
    payload: requirementPayload(statement),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
}

async function addCriterion(
  specId: string,
  revisionId: string,
  parentElementId: string,
  text = "A transition without approval is refused.",
  position = 1,
) {
  return repo.createDraftElement({
    id: nextId("criterion"),
    specId,
    revisionId,
    kind: "criterion",
    parentElementId,
    position,
    payload: criterionPayload(text),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
}

describe("maximal persistence contracts", () => {
  it("round-trips every persisted spec field", async () => {
    await assertRoundTripDurability({
      label: "specs",
      schema: specSchema,
      buildMaximalFixture: () =>
        specSchema.parse({
          id: "spec-maximal",
          projectPath: PROJECT_PATH,
          slug: "native-sdd",
          name: "Native spec-driven development",
          gatePolicy: {
            preset: "exploratory",
            overrides: {
              requirements: "gate",
              delivery: "notify",
            },
          },
          abandonedAt: APPROVED_AT,
          abandonedReason: "The product direction changed.",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        await repo.create({
          spec: {
            id: maximal.id,
            projectPath: maximal.projectPath,
            slug: maximal.slug,
            name: maximal.name,
            gatePolicy: maximal.gatePolicy,
            createdAt: maximal.createdAt,
            updatedAt: maximal.createdAt,
          },
          initialRevision: {
            id: "revision-for-maximal-spec",
            createdAt: maximal.createdAt,
          },
        });
        return repo.abandon({
          specId: maximal.id,
          abandonedAt: requireFixtureString(maximal.abandonedAt, "abandonedAt"),
          reason: requireFixtureString(
            maximal.abandonedReason,
            "abandonedReason",
          ),
          updatedAt: maximal.updatedAt,
        });
      },
      reload: (expected) => repo.findById(expected.id),
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted alias field through rename", async () => {
    const created = await createSpec({
      id: "spec-alias-maximal",
      slug: "old-native-sdd",
    });

    await assertRoundTripDurability({
      label: "spec-aliases",
      schema: specAliasSchema,
      buildMaximalFixture: () =>
        specAliasSchema.parse({
          projectPath: PROJECT_PATH,
          slug: "old-native-sdd",
          specId: created.spec.id,
          createdAt: PROPOSED_AT,
        }),
      persist: async (maximal) => {
        const renamed = await repo.rename({
          specId: maximal.specId,
          slug: "native-sdd",
          name: "Native SDD renamed",
          updatedAt: UPDATED_AT,
          aliasCreatedAt: maximal.createdAt,
        });
        return renamed.alias;
      },
      reload: async (expected) =>
        (await repo.listAliases(expected.specId)).find(
          (alias) => alias.slug === expected.slug,
        ) ?? null,
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted counter field", async () => {
    const created = await createSpec({ id: "spec-counter-maximal" });

    await assertRoundTripDurability({
      label: "spec-counters",
      schema: specCounterSchema,
      buildMaximalFixture: () =>
        specCounterSchema.parse({
          specId: created.spec.id,
          scopeKey: "C:requirement-maximal",
          lastNumber: 7,
        }),
      persist: async (maximal) => {
        for (let index = 0; index < maximal.lastNumber; index += 1) {
          await repo.allocateNumber(maximal.specId, maximal.scopeKey);
        }
        const persisted = await repo.findCounter(
          maximal.specId,
          maximal.scopeKey,
        );
        if (!persisted) throw new Error("counter was not persisted");
        return persisted;
      },
      reload: (expected) =>
        repo.findCounter(expected.specId, expected.scopeKey),
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted element field with criterion identity nested under its requirement", async () => {
    const created = await createSpec({ id: "spec-element-maximal" });
    const parent = await addRequirement(created.spec.id, created.revision.id);

    await assertRoundTripDurability({
      label: "spec-elements",
      schema: specElementSchema,
      buildMaximalFixture: () =>
        specElementSchema.parse({
          id: "criterion-maximal",
          specId: created.spec.id,
          kind: "criterion",
          number: 1,
          parentElementId: parent.element.id,
          createdAt: PROPOSED_AT,
        }),
      persist: async (maximal) => {
        const persisted = await repo.createDraftElement({
          id: maximal.id,
          specId: maximal.specId,
          revisionId: created.revision.id,
          kind: maximal.kind,
          parentElementId: maximal.parentElementId,
          position: 1,
          payload: criterionPayload("A maximal criterion payload."),
          createdAt: maximal.createdAt,
          updatedAt: UPDATED_AT,
        });
        return persisted.element;
      },
      reload: (expected) => repo.findElement(expected.id),
      fieldPolicies: { number: "derived-on-write" },
    });
  });

  it("round-trips every persisted revision field through draft, propose, and approve", async () => {
    const created = await createSpec({ id: "spec-revision-maximal" });
    await addRequirement(created.spec.id, created.revision.id);
    await repo.proposeRevision({
      revisionId: created.revision.id,
      proposedAt: PROPOSED_AT,
    });
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    await assertRoundTripDurability({
      label: "spec-revisions",
      schema: specRevisionSchema,
      buildMaximalFixture: () =>
        specRevisionSchema.parse({
          id: "revision-maximal",
          specId: created.spec.id,
          number: 2,
          state: "approved",
          basedOnRevisionId: created.revision.id,
          contentHash: "derived-by-propose",
          proposedAt: PROPOSED_AT,
          approvedAt: APPROVED_AT,
          createdAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        await repo.createDraftFromBase({
          id: maximal.id,
          specId: maximal.specId,
          baseRevisionId: requireFixtureString(
            maximal.basedOnRevisionId,
            "basedOnRevisionId",
          ),
          createdAt: maximal.createdAt,
        });
        await repo.proposeRevision({
          revisionId: maximal.id,
          proposedAt: requireFixtureString(maximal.proposedAt, "proposedAt"),
        });
        return repo.approveRevision({
          revisionId: maximal.id,
          approvedAt: requireFixtureString(maximal.approvedAt, "approvedAt"),
        });
      },
      reload: (expected) => repo.findRevision(expected.id),
      fieldPolicies: { contentHash: "derived-on-write" },
    });
  });

  it("round-trips every persisted element-version field", async () => {
    const created = await createSpec({ id: "spec-version-maximal" });
    const parent = await addRequirement(created.spec.id, created.revision.id);

    await assertRoundTripDurability({
      label: "spec-element-versions",
      schema: specElementVersionSchema,
      buildMaximalFixture: () =>
        specElementVersionSchema.parse({
          revisionId: created.revision.id,
          elementId: "criterion-version-maximal",
          position: 7,
          payload: criterionPayload("The maximal version payload."),
          payloadHash: "derived-from-payload",
          elementVersion: 1,
          createdAt: PROPOSED_AT,
          updatedAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        const persisted = await repo.createDraftElement({
          id: maximal.elementId,
          specId: created.spec.id,
          revisionId: maximal.revisionId,
          kind: "criterion",
          parentElementId: parent.element.id,
          position: maximal.position,
          payload: maximal.payload,
          createdAt: maximal.createdAt,
          updatedAt: maximal.updatedAt,
        });
        return persisted.version;
      },
      reload: (expected) =>
        repo.findElementVersion(expected.revisionId, expected.elementId),
      fieldPolicies: { payloadHash: "derived-on-write" },
    });
  });
});

describe("revision snapshots and aliases", () => {
  it("copies a complete base row-set into one new draft snapshot", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const criterion = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
    );
    await repo.proposeRevision({
      revisionId: created.revision.id,
      proposedAt: PROPOSED_AT,
    });
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    const draft = await repo.createDraftFromBase({
      id: "revision-amendment",
      specId: created.spec.id,
      baseRevisionId: created.revision.id,
      createdAt: UPDATED_AT,
    });
    const snapshot = await repo.getRevisionSnapshot(draft.id);

    expect(snapshot?.revision).toEqual(draft);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      requirement.element.id,
      criterion.element.id,
    ]);
    expect(
      snapshot?.elements.map(({ version }) => version.elementVersion),
    ).toEqual([1, 1]);
    expect(snapshot?.elements.map(({ version }) => version.createdAt)).toEqual([
      UPDATED_AT,
      UPDATED_AT,
    ]);
  });

  it("freezes the exact proposed snapshot behind a canonical content hash", async () => {
    const created = await createSpec();
    await addRequirement(created.spec.id, created.revision.id);

    const proposed = await repo.proposeRevision({
      revisionId: created.revision.id,
      proposedAt: PROPOSED_AT,
    });
    const verification = await repo.verifyRevision(created.revision.id);

    expect(proposed.state).toBe("proposed");
    expect(proposed.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verification).toEqual({
      ok: true,
      expectedContentHash: proposed.contentHash,
      actualContentHash: proposed.contentHash,
      mismatchedElementIds: [],
    });
  });

  it("resolves a renamed spec by both its current slug and appended alias", async () => {
    const created = await createSpec({ slug: "old-slug" });
    await repo.rename({
      specId: created.spec.id,
      slug: "current-slug",
      name: "Current name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });

    expect(await repo.resolve(PROJECT_PATH, "current-slug")).toMatchObject({
      id: created.spec.id,
      slug: "current-slug",
    });
    expect(await repo.resolve(PROJECT_PATH, "old-slug")).toMatchObject({
      id: created.spec.id,
      slug: "current-slug",
    });
  });

  it("refuses to create a spec whose slug is another spec's historical alias", async () => {
    const original = await createSpec({
      id: "spec-original",
      slug: "reserved-slug",
    });
    await repo.rename({
      specId: original.spec.id,
      slug: "current-slug",
      name: "Current name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });

    await expect(
      createSpec({ id: "spec-shadowing-create", slug: "reserved-slug" }),
    ).rejects.toMatchObject({
      failure: {
        kind: "constraint",
        constraint: "spec_slug_namespace",
        entity: "spec",
        identifier: `${PROJECT_PATH}/reserved-slug`,
      },
    });
    expect(await repo.findById("spec-shadowing-create")).toBeNull();
    expect(
      await repo.findRevision("spec-shadowing-create-revision-1"),
    ).toBeNull();
    expect(await repo.resolve(PROJECT_PATH, "reserved-slug")).toMatchObject({
      id: original.spec.id,
      slug: "current-slug",
    });
  });

  it("refuses to rename a spec to another spec's historical alias", async () => {
    const original = await createSpec({
      id: "spec-original",
      slug: "reserved-slug",
    });
    await repo.rename({
      specId: original.spec.id,
      slug: "current-slug",
      name: "Current name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });
    const other = await createSpec({ id: "spec-other", slug: "other-slug" });

    await expect(
      repo.rename({
        specId: other.spec.id,
        slug: "reserved-slug",
        name: "Shadowing rename",
        updatedAt: UPDATED_AT,
        aliasCreatedAt: PROPOSED_AT,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "constraint",
        constraint: "spec_slug_namespace",
        entity: "spec",
        identifier: `${PROJECT_PATH}/reserved-slug`,
      },
    });
    expect(await repo.resolve(PROJECT_PATH, "reserved-slug")).toMatchObject({
      id: original.spec.id,
      slug: "current-slug",
    });
    expect(await repo.resolve(PROJECT_PATH, "other-slug")).toMatchObject({
      id: other.spec.id,
      slug: "other-slug",
    });
  });

  it("allows a spec to rename back to one of its own historical aliases", async () => {
    const created = await createSpec({ slug: "first-slug" });
    await repo.rename({
      specId: created.spec.id,
      slug: "second-slug",
      name: "Second name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });

    await expect(
      repo.rename({
        specId: created.spec.id,
        slug: "first-slug",
        name: "First name restored",
        updatedAt: APPROVED_AT,
        aliasCreatedAt: APPROVED_AT,
      }),
    ).resolves.toMatchObject({
      spec: { id: created.spec.id, slug: "first-slug" },
    });
  });
});

describe("counter allocation", () => {
  it("allocates unique numbers under interleaving and never reuses them", async () => {
    const created = await createSpec();

    const allocated = await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.allocateNumber(created.spec.id, "C:requirement-1"),
      ),
    );

    expect([...allocated].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(await repo.allocateNumber(created.spec.id, "C:requirement-1")).toBe(
      21,
    );
  });

  it("keeps every handle scope independent", async () => {
    const created = await createSpec();
    const scopes = ["R", "D", "T", "Q", "A", "C:requirement-1"] as const;

    expect(
      await Promise.all(
        scopes.map((scope) => repo.allocateNumber(created.spec.id, scope)),
      ),
    ).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("draft compare-and-swap", () => {
  async function createTwoCriteria() {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const first = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
      "First criterion",
      1,
    );
    const second = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
      "Second criterion",
      2,
    );
    return { created, first, second };
  }

  it("lets interleaved writers update independent elements without losing either write", async () => {
    const { first, second } = await createTwoCriteria();

    await Promise.all([
      repo.updateDraftElement({
        revisionId: first.version.revisionId,
        elementId: first.element.id,
        expectedElementVersion: first.version.elementVersion,
        payload: criterionPayload("First writer landed."),
      }),
      repo.updateDraftElement({
        revisionId: second.version.revisionId,
        elementId: second.element.id,
        expectedElementVersion: second.version.elementVersion,
        payload: criterionPayload("Second writer landed."),
      }),
    ]);

    expect(
      await repo.findElementVersion(first.version.revisionId, first.element.id),
    ).toMatchObject({
      elementVersion: 2,
      payload: { text: "First writer landed." },
    });
    expect(
      await repo.findElementVersion(
        second.version.revisionId,
        second.element.id,
      ),
    ).toMatchObject({
      elementVersion: 2,
      payload: { text: "Second writer landed." },
    });
  });

  it("returns current content in a typed stale_element conflict and preserves the winning write", async () => {
    const { first } = await createTwoCriteria();
    const winnerPayload = criterionPayload("The first writer wins the CAS.");
    const stalePayload = criterionPayload("A stale writer must not overwrite.");

    const winner = await repo.updateDraftElement({
      revisionId: first.version.revisionId,
      elementId: first.element.id,
      expectedElementVersion: first.version.elementVersion,
      payload: winnerPayload,
    });

    const conflict = await repo
      .updateDraftElement({
        revisionId: first.version.revisionId,
        elementId: first.element.id,
        expectedElementVersion: first.version.elementVersion,
        payload: stalePayload,
      })
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(StaleElementConflictError);
    expect(conflict).toMatchObject({
      code: "stale_element",
      revisionId: first.version.revisionId,
      elementId: first.element.id,
      expectedElementVersion: 1,
      current: {
        elementVersion: 2,
        payload: winnerPayload,
      },
    });
    expect(
      await repo.findElementVersion(first.version.revisionId, first.element.id),
    ).toEqual(winner);
  });

  it("refuses content writes after a revision is approved", async () => {
    const { created, first } = await createTwoCriteria();
    await repo.proposeRevision({
      revisionId: created.revision.id,
      proposedAt: PROPOSED_AT,
    });
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    await expect(
      repo.updateDraftElement({
        revisionId: created.revision.id,
        elementId: first.element.id,
        expectedElementVersion: first.version.elementVersion,
        payload: criterionPayload("Approved content cannot change."),
      }),
    ).rejects.toBeInstanceOf(SpecRevisionImmutableError);
  });

  it("rejects a criterion whose parent is not a requirement", async () => {
    const created = await createSpec();
    const section = await repo.createDraftElement({
      id: nextId("section"),
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "section",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "section",
        role: "intent_problem",
        title: "Problem",
        body: "Prompt etiquette is not enforcement.",
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });

    await expect(
      repo.createDraftElement({
        id: nextId("criterion"),
        specId: created.spec.id,
        revisionId: created.revision.id,
        kind: "criterion",
        parentElementId: section.element.id,
        position: 1,
        payload: criterionPayload("This parent is invalid."),
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "validation", entity: "spec_element" },
    });
  });

  it.each([
    ["requirement", requirementPayload("A requirement payload.")],
    ["criterion", criterionPayload("A criterion payload.")],
  ] as const)(
    "refuses a %s identity whose payload declares a different element kind",
    async (kind, payload) => {
      const created = await createSpec();
      const mismatchedPayload: SpecElementPayload =
        payload.kind === "requirement"
          ? criterionPayload("Wrong payload kind.")
          : requirementPayload("Wrong payload kind.");

      await expect(
        repo.createDraftElement({
          id: nextId("mismatch"),
          specId: created.spec.id,
          revisionId: created.revision.id,
          kind,
          parentElementId: null,
          position: 0,
          payload: mismatchedPayload,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toMatchObject({
        failure: { kind: "validation", entity: "spec_element" },
      });
    },
  );
});
