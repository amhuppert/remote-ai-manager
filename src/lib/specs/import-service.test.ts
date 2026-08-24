import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SSEEvent } from "@/lib/api/sse-events";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";

import { createSpecEventsPublisher } from "./events";
import { createImportService, type ImportService } from "./import-service";
import { elementHandleInSnapshot } from "./review-state";

const PROJECT_PATH = "/repos/spec-import";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-import-1",
} as const;

/**
 * Every table an import could leave a row in. The refusal-atomicity tests read
 * the whole set rather than the `specs` row alone: a partial write that created
 * a counter or an event without its spec is exactly the failure R1.2 forbids,
 * and a spec-only assertion would not see it.
 */
const SPEC_TABLES = [
  "specs",
  "spec_aliases",
  "spec_revisions",
  "spec_elements",
  "spec_element_versions",
  "spec_counters",
  "spec_questions",
  "spec_assumptions",
  "spec_approvals",
  "spec_gate_admissions",
  "spec_events",
] as const;

interface Harness {
  readonly fixture: PersistenceFixture;
  readonly service: ImportService;
  readonly events: ReturnType<typeof createSpecEventsRepo>;
  readonly review: ReturnType<typeof createSpecReviewRepo>;
  readonly notifications: ReturnType<typeof createNotificationsRepo>;
  readonly published: SSEEvent[];
}

let harness: Harness;

function rowCounts(fixture: PersistenceFixture): Record<string, number> {
  return Object.fromEntries(
    SPEC_TABLES.map((table) => [
      table,
      (
        fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
    ]),
  );
}

function dumpSpecRows(
  fixture: PersistenceFixture,
  specId: string,
): Record<string, unknown[]> {
  const bySpec = (table: string): unknown[] =>
    table === "specs"
      ? fixture.db.prepare("SELECT * FROM specs WHERE id = ?").all(specId)
      : fixture.db
          .prepare(`SELECT * FROM ${table} WHERE spec_id = ?`)
          .all(specId);
  const elementIds = (
    fixture.db
      .prepare("SELECT id FROM spec_elements WHERE spec_id = ?")
      .all(specId) as { id: string }[]
  ).map(({ id }) => id);
  return {
    ...Object.fromEntries(
      SPEC_TABLES.filter((table) => table !== "spec_element_versions").map(
        (table) => [table, bySpec(table)],
      ),
    ),
    spec_element_versions: elementIds.flatMap((elementId) =>
      fixture.db
        .prepare("SELECT * FROM spec_element_versions WHERE element_id = ?")
        .all(elementId),
    ),
  };
}

/**
 * Bundles are authored documents of arbitrary validity — the service, not the
 * caller, decides whether one is admissible — so the overrides are typed as a
 * loose record and the result as `unknown`. Typing them to `ImportBundle` would
 * make the invalid-bundle cases uncompilable without a cast.
 */
function bundle(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: "imported-feature",
    name: "Imported Feature",
    source: { label: "kiro:.kiro/specs/legacy-feature" },
    sections: [
      {
        role: "intent_problem",
        title: "Problem",
        body: "The legacy spec lived outside Command Center.",
      },
      {
        role: "design_narrative",
        title: "Design",
        body: "One transaction creates the whole spec.",
      },
    ],
    requirements: [
      {
        ref: "authoring",
        statement: "An agent imports an external spec in one shot.",
        priority: "must",
        risk: "high",
        criteria: [
          {
            text: "A valid bundle yields an approved design-stage revision.",
            validationStrategy: { kinds: ["test_run"] },
          },
          {
            text: "A refusal leaves no trace of the attempted spec.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
      {
        ref: "gates",
        statement: "Import never satisfies a human gate.",
        priority: "must",
        risk: "high",
        criteria: [
          {
            text: "Zero approval rows exist after an import.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
    ],
    decisions: [
      {
        title: "Import writes admissions, never approvals",
        chosenApproach:
          "Record an import-basis gate admission per authoring gate.",
        rejectedAlternatives: [
          {
            label: "Synthesize approval rows",
            reason: "Would forge a human act.",
          },
        ],
        reason: "Provenance must never read as an approval.",
        traces: ["authoring", "gates"],
      },
    ],
    questions: [
      {
        text: "Which external source formats are in scope?",
        answer: "Any — the bundle is source-agnostic.",
      },
    ],
    assumptions: [
      {
        text: "The external source already shipped.",
        disposition: "confirmed",
      },
    ],
    ...overrides,
  };
}

/**
 * Every row in the database, not just the spec tables. A dry run claims to
 * write nothing at all, and a spec-scoped dump could not see a counter, an
 * event, or a notification it left behind in a table the import is not
 * supposed to touch.
 */
function dumpDatabase(fixture: PersistenceFixture): Record<string, unknown[]> {
  const tables = (
    fixture.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      fixture.db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
}

function importBundle(input: unknown = bundle()) {
  return harness.service.importSpec({
    projectPath: PROJECT_PATH,
    bundle: input,
    actor: AGENT,
  });
}

async function expectImported(input?: unknown) {
  const result = await importBundle(input ?? bundle());
  if (!result.ok) {
    throw new Error(
      `expected import to succeed, refused: ${JSON.stringify(result.refusal)}`,
    );
  }
  if (result.dryRun) {
    throw new Error("expected a real import, got a dry-run preview");
  }
  return result.value;
}

async function expectPreviewed(input?: unknown) {
  const result = await importBundle(input ?? bundle({ dryRun: true }));
  if (!result.ok) {
    throw new Error(
      `expected the dry run to be admitted, refused: ${JSON.stringify(result.refusal)}`,
    );
  }
  if (!result.dryRun) {
    throw new Error("expected a dry-run preview, got a real import");
  }
  return result.preview;
}

beforeEach(() => {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const published: SSEEvent[] = [];
  const events = createSpecEventsRepo(fixture.db);
  const review = createSpecReviewRepo(fixture.db);
  let ids = 0;
  let times = 0;
  const service = createImportService({
    specs: fixture.specs,
    review,
    links: createSpecLinksRepo(fixture.db),
    events: createSpecEventsPublisher({
      appendInTransaction: events.appendInTransaction,
      publish(event) {
        published.push(event);
        return { delivered: true };
      },
    }),
    newId(prefix) {
      ids += 1;
      return `${prefix}-${ids}`;
    },
    now() {
      times += 1;
      return `2026-08-11T09:00:${String(times).padStart(2, "0")}.000Z`;
    },
  });
  harness = {
    fixture,
    service,
    events,
    review,
    notifications: createNotificationsRepo(fixture.db),
    published,
  };
});

afterEach(() => harness.fixture.close());

describe("spec import creates a born-approved spec atomically (R1.1)", () => {
  it("yields one approved design-stage revision carrying every bundle element", async () => {
    const receipt = await expectImported();

    const spec = await harness.fixture.specs.resolve(
      PROJECT_PATH,
      "imported-feature",
    );
    expect(spec).not.toBeNull();
    expect(spec?.name).toBe("Imported Feature");
    expect(spec?.gatePolicy).toEqual({ preset: "contract-bearing" });

    const revisions = await harness.fixture.specs.listRevisions(
      receipt.spec.id,
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.state).toBe("approved");
    expect(revisions[0]?.authoringStage).toBe("design");
    expect(revisions[0]?.approvedAt).not.toBeNull();
    expect(revisions[0]?.contentHash).not.toBeNull();
    expect(await harness.fixture.specs.findDraft(receipt.spec.id)).toBeNull();

    const snapshot = await harness.fixture.specs.getRevisionSnapshot(
      revisions[0]?.id ?? "",
    );
    const elements = snapshot?.elements ?? [];
    const payloads = elements.map(({ version }) => version.payload);
    const requirementIds = elements
      .filter(({ element }) => element.kind === "requirement")
      .map(({ element }) => element.id);
    expect(payloads).toEqual([
      {
        kind: "section",
        role: "intent_problem",
        title: "Problem",
        body: "The legacy spec lived outside Command Center.",
      },
      {
        kind: "section",
        role: "design_narrative",
        title: "Design",
        body: "One transaction creates the whole spec.",
      },
      {
        kind: "requirement",
        statement: "An agent imports an external spec in one shot.",
        priority: "must",
        risk: "high",
      },
      {
        kind: "criterion",
        text: "A valid bundle yields an approved design-stage revision.",
        validationStrategy: { kinds: ["test_run"] },
      },
      {
        kind: "criterion",
        text: "A refusal leaves no trace of the attempted spec.",
        validationStrategy: { kinds: ["test_run"] },
      },
      {
        kind: "requirement",
        statement: "Import never satisfies a human gate.",
        priority: "must",
        risk: "high",
      },
      {
        kind: "criterion",
        text: "Zero approval rows exist after an import.",
        validationStrategy: { kinds: ["test_run"] },
      },
      {
        kind: "decision",
        title: "Import writes admissions, never approvals",
        chosenApproach:
          "Record an import-basis gate admission per authoring gate.",
        rejectedAlternatives: [
          {
            label: "Synthesize approval rows",
            reason: "Would forge a human act.",
          },
        ],
        reason: "Provenance must never read as an approval.",
        tracedRequirementElementIds: requirementIds,
      },
    ]);
    for (const { version } of elements) {
      expect(version.elementVersion).toBe(1);
    }

    expect(harness.review.findQuestionsBySpecId(receipt.spec.id)).toHaveLength(
      1,
    );
    expect(
      harness.review.findAssumptionsBySpecId(receipt.spec.id),
    ).toHaveLength(1);
  });

  it("numbers handles through the spec counters and resolves bundle-local references (R1.3)", async () => {
    const receipt = await expectImported();
    const snapshot = await harness.fixture.specs.getRevisionSnapshot(
      receipt.revision.id,
    );
    const elements = snapshot?.elements ?? [];
    const byKind = (kind: string) =>
      elements.filter(({ element }) => element.kind === kind);

    const requirements = byKind("requirement");
    expect(requirements.map(({ element }) => element.number)).toEqual([1, 2]);
    // Criterion numbers are per-requirement (R1.1, R1.2, R2.1), so the second
    // requirement's first criterion restarts at 1 exactly as native authoring.
    expect(byKind("criterion").map(({ element }) => element.number)).toEqual([
      1, 2, 1,
    ]);
    expect(byKind("decision").map(({ element }) => element.number)).toEqual([
      1,
    ]);

    const requirementIds = requirements.map(({ element }) => element.id);
    expect(
      byKind("criterion").map(({ element }) => element.parentElementId),
    ).toEqual([requirementIds[0], requirementIds[0], requirementIds[1]]);

    const decision = byKind("decision")[0]?.version.payload;
    expect(
      decision?.kind === "decision" ? decision.tracedRequirementElementIds : [],
    ).toEqual(requirementIds);

    expect(
      (await harness.fixture.specs.findCounter(receipt.spec.id, "R"))
        ?.lastNumber,
    ).toBe(2);
    expect(
      (await harness.fixture.specs.findCounter(receipt.spec.id, "D"))
        ?.lastNumber,
    ).toBe(1);
    expect(
      (await harness.fixture.specs.findCounter(receipt.spec.id, "Q"))
        ?.lastNumber,
    ).toBe(1);
    expect(
      (await harness.fixture.specs.findCounter(receipt.spec.id, "A"))
        ?.lastNumber,
    ).toBe(1);
  });
});

describe("every import refusal leaves no trace of the attempted spec (R1.2)", () => {
  it("refuses a bundle that violates the schema and writes nothing", async () => {
    const before = rowCounts(harness.fixture);
    const result = await importBundle(
      bundle({
        requirements: [
          {
            statement: "A requirement with an unknown priority.",
            // Deliberately outside `requirementPrioritySchema`.
            priority: "urgent",
            risk: "high",
            criteria: [],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("validation");
    expect(rowCounts(harness.fixture)).toEqual(before);
    expect(
      await harness.fixture.specs.resolve(PROJECT_PATH, "imported-feature"),
    ).toBeNull();
  });

  it("refuses a decision tracing a bundle-local reference no requirement declares", async () => {
    const before = rowCounts(harness.fixture);
    const result = await importBundle(
      bundle({
        decisions: [
          {
            title: "Trace a requirement that is not in the bundle",
            chosenApproach: "Point at a ref nothing declares.",
            rejectedAlternatives: [],
            reason: "Proves the reference check runs before any write.",
            traces: ["missing-requirement"],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("dangling_reference");
    expect(result.ok ? "" : JSON.stringify(result.refusal)).toContain(
      "missing-requirement",
    );
    expect(rowCounts(harness.fixture)).toEqual(before);
    expect(
      await harness.fixture.specs.resolve(PROJECT_PATH, "imported-feature"),
    ).toBeNull();
  });

  /**
   * The one refusal class that rolls back rather than refusing before the
   * first write: lint judges committed content, so the spec, its revision, its
   * elements, and its questions and assumptions all exist inside the
   * transaction by the time the finding is raised. These cases are what prove
   * the transaction itself is atomic — the other three classes never write.
   */
  it("refuses a bundle whose requirement carries no criterion and rolls the whole write back", async () => {
    const before = rowCounts(harness.fixture);
    const result = await importBundle(
      bundle({
        // Opted out of delivered marking so the bundle reaches the lint at all:
        // a criteria-less bundle claiming delivery is refused before the first
        // write (R4.2), which would prove nothing about the rollback.
        delivered: false,
        requirements: [
          {
            ref: "unreviewable",
            statement: "A requirement nothing can review.",
            priority: "must",
            risk: "high",
            criteria: [],
          },
        ],
        decisions: [],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("lint_blocked");
    expect(
      result.ok
        ? []
        : result.refusal.findings?.map((finding) =>
            typeof finding === "object" &&
            finding !== null &&
            "ruleId" in finding
              ? finding.ruleId
              : null,
          ),
    ).toContain("9.2.empty-spec");
    expect(rowCounts(harness.fixture)).toEqual(before);
    expect(
      await harness.fixture.specs.resolve(PROJECT_PATH, "imported-feature"),
    ).toBeNull();
  });

  it("refuses a bundle of sections alone and rolls the whole write back", async () => {
    const before = rowCounts(harness.fixture);
    const result = await importBundle(
      bundle({ delivered: false, requirements: [], decisions: [] }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("lint_blocked");
    expect(rowCounts(harness.fixture)).toEqual(before);
    expect(
      await harness.fixture.specs.resolve(PROJECT_PATH, "imported-feature"),
    ).toBeNull();
  });

  it("refuses duplicate bundle-local requirement refs before any write", async () => {
    const before = rowCounts(harness.fixture);
    const result = await importBundle(
      bundle({
        requirements: [
          {
            ref: "shared",
            statement: "The first requirement claiming the ref.",
            priority: "must",
            risk: "high",
            criteria: [
              {
                text: "A criterion so the spec is reviewable.",
                validationStrategy: { kinds: ["test_run"] },
              },
            ],
          },
          {
            ref: "shared",
            statement: "The second requirement claiming the same ref.",
            priority: "must",
            risk: "high",
            criteria: [
              {
                text: "Another criterion.",
                validationStrategy: { kinds: ["test_run"] },
              },
            ],
          },
        ],
        decisions: [
          {
            title: "A decision whose trace would be ambiguous",
            chosenApproach: "Trace the duplicated ref.",
            rejectedAlternatives: [],
            reason:
              "A silently-resolved duplicate would trace the wrong requirement.",
            traces: ["shared"],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("validation");
    expect(result.ok ? "" : JSON.stringify(result.refusal)).toContain("shared");
    expect(rowCounts(harness.fixture)).toEqual(before);
  });

  it("refuses a slug collision and leaves the existing spec byte-identical (R2.1)", async () => {
    const existing = await expectImported();
    const before = dumpSpecRows(harness.fixture, existing.spec.id);
    const counts = rowCounts(harness.fixture);

    const result = await importBundle(bundle({ name: "Second Import" }));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("slug_taken");
    expect(dumpSpecRows(harness.fixture, existing.spec.id)).toEqual(before);
    expect(rowCounts(harness.fixture)).toEqual(counts);
  });

  it("refuses a slug an alias of another spec already shadows (R2.1)", async () => {
    const existing = await expectImported();
    await harness.fixture.specs.rename({
      specId: existing.spec.id,
      slug: "renamed-feature",
      name: existing.spec.name,
      updatedAt: "2026-08-11T10:00:00.000Z",
      aliasCreatedAt: "2026-08-11T10:00:00.000Z",
    });
    const before = dumpSpecRows(harness.fixture, existing.spec.id);

    const result = await importBundle();

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("slug_taken");
    expect(dumpSpecRows(harness.fixture, existing.spec.id)).toEqual(before);
  });

  it("refuses an abandoned spec's slug rather than reviving or amending it (R2.2)", async () => {
    const existing = await expectImported();
    await harness.fixture.specs.abandon({
      specId: existing.spec.id,
      abandonedAt: "2026-08-11T10:00:00.000Z",
      reason: "Superseded by a native spec.",
      updatedAt: "2026-08-11T10:00:00.000Z",
    });
    const before = dumpSpecRows(harness.fixture, existing.spec.id);

    const result = await importBundle();

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("slug_taken");
    expect(dumpSpecRows(harness.fixture, existing.spec.id)).toEqual(before);
    expect(
      await harness.fixture.specs.listRevisions(existing.spec.id),
    ).toHaveLength(1);
    expect(
      (await harness.fixture.specs.findById(existing.spec.id))?.abandonedAt,
    ).toBe("2026-08-11T10:00:00.000Z");
  });
});

describe("an import records provenance, never approval (R3.2, R7.3, R7.4, R10)", () => {
  it("admits the authoring gates on the import basis with zero approval rows", async () => {
    const receipt = await expectImported();

    const admissions = harness.review
      .findGateAdmissionsBySpecId(receipt.spec.id)
      .map(({ gate, basis, approval_id, revision_id, execution_id }) => ({
        gate,
        basis,
        approval_id,
        revision_id,
        execution_id,
      }));
    expect(admissions).toEqual([
      {
        gate: "requirements",
        basis: "import",
        approval_id: null,
        revision_id: receipt.revision.id,
        execution_id: null,
      },
      {
        gate: "design",
        basis: "import",
        approval_id: null,
        revision_id: receipt.revision.id,
        execution_id: null,
      },
    ]);
    expect(harness.review.findApprovalsBySpecId(receipt.spec.id)).toEqual([]);
  });

  it("lands answered questions and stated assumption dispositions with import provenance", async () => {
    const receipt = await expectImported(
      bundle({
        questions: [
          { text: "Answered in the bundle?", answer: "Yes." },
          { text: "Still open?" },
        ],
        assumptions: [
          { text: "Already shipped.", disposition: "confirmed" },
          { text: "Disposition omitted." },
        ],
      }),
    );

    const questions = harness.review.findQuestionsBySpecId(receipt.spec.id);
    expect(
      questions.map(({ number, status, answer }) => ({
        number,
        status,
        answer,
      })),
    ).toEqual([
      { number: 1, status: "answered", answer: "Yes." },
      { number: 2, status: "open", answer: null },
    ]);
    expect(questions[0]?.answered_at).not.toBeNull();
    for (const question of questions) {
      expect(JSON.parse(question.provenance_json)).toEqual(AGENT);
    }

    const assumptions = harness.review.findAssumptionsBySpecId(receipt.spec.id);
    expect(
      assumptions.map(({ number, disposition }) => ({ number, disposition })),
    ).toEqual([
      { number: 1, disposition: "confirmed" },
      { number: 2, disposition: "proposed" },
    ]);
    for (const assumption of assumptions) {
      expect(JSON.parse(assumption.proposed_by_json)).toEqual(AGENT);
    }
  });

  it("appends a spec_imported event with the source label and content counts (R7.4, R10.1)", async () => {
    const receipt = await expectImported();

    const imported = harness.events
      .findBySpecId(receipt.spec.id)
      .filter(({ event_type }) => event_type === "spec_imported");
    expect(imported).toHaveLength(1);
    expect(JSON.parse(imported[0]?.payload_json ?? "{}")).toEqual({
      source: { label: "kiro:.kiro/specs/legacy-feature" },
      revisionId: receipt.revision.id,
      counts: {
        sections: 2,
        requirements: 2,
        criteria: 3,
        decisions: 1,
        questions: 1,
        assumptions: 1,
      },
    });
  });

  it("publishes spec-changed through the publication seam (R10.1)", async () => {
    const receipt = await expectImported();

    expect(harness.published).toEqual([
      expect.objectContaining({
        type: "spec-changed",
        projectPath: PROJECT_PATH,
        specId: receipt.spec.id,
        specSlug: "imported-feature",
        revisionId: receipt.revision.id,
      }),
    ]);
  });

  it("records external delivery as testimony on the imported revision by default (R4.1)", async () => {
    const receipt = await expectImported();

    const revisions = await harness.fixture.specs.listRevisions(
      receipt.spec.id,
    );
    expect(revisions[0]?.externalDelivery).toEqual({
      // The instant the import committed, not one the bundle chose: the claim
      // is that the source shipped before this import, and the only date this
      // system can honestly stamp is its own.
      at: revisions[0]?.approvedAt,
      actor: AGENT,
      source: { label: "kiro:.kiro/specs/legacy-feature" },
    });
    expect(receipt.revision.externalDelivery).toEqual(
      revisions[0]?.externalDelivery,
    );
  });

  it("records typed import history without approval-request notifications (R10.2)", async () => {
    const receipt = await expectImported();

    const events = harness.events.findBySpecId(receipt.spec.id);
    expect(events.map(({ event_type }) => event_type)).toEqual([
      "spec-review-record-mutated",
      "spec-review-record-mutated",
      "spec_imported",
    ]);
    expect(
      events.slice(0, 2).map(({ payload_json }) => JSON.parse(payload_json)),
    ).toEqual([
      expect.objectContaining({
        recordKind: "question",
        operation: "imported",
        active: false,
      }),
      expect.objectContaining({
        recordKind: "assumption",
        operation: "imported",
        active: false,
      }),
    ]);
    expect(harness.events.listOpenApprovalRequests(receipt.spec.id)).toEqual(
      [],
    );
    expect(
      harness.notifications.findSpecNotificationsBySpecId(receipt.spec.id),
    ).toEqual([]);
  });
});

describe("delivered marking is decided explicitly, never silently (R4.2)", () => {
  /**
   * The delivered claim is carried by the imported criteria — the phase reads
   * delivered because every criterion does. A bundle with none would leave the
   * claim with nothing to attach to, so it is refused rather than imported as
   * approved: dropping the marking silently is exactly what R4.2 forbids.
   */
  it("refuses a criteria-less bundle whose delivered marking is in effect by default", async () => {
    const before = rowCounts(harness.fixture);

    const result = await importBundle(
      bundle({ requirements: [], decisions: [] }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("validation");
    // The remedy names the opt-out, so a criteria-less source is importable in
    // one retry rather than by guessing which field to change.
    expect(result.ok ? "" : result.refusal.instruction).toContain(
      '"delivered": false',
    );
    expect(rowCounts(harness.fixture)).toEqual(before);
    expect(
      await harness.fixture.specs.resolve(PROJECT_PATH, "imported-feature"),
    ).toBeNull();
  });

  it("refuses a criteria-less bundle that marks delivered explicitly", async () => {
    const result = await importBundle(
      bundle({ delivered: true, requirements: [], decisions: [] }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("validation");
  });

  /**
   * Opting out clears the delivered refusal, which is all the opt-out decides.
   * A criteria-less bundle is still refused — by the propose-parity lint (R1.2)
   * that blocks every spec with no reviewable requirement, imported or
   * authored. The two refusals are distinguishable here so a later change that
   * let the delivered check swallow the lint would fail this test.
   */
  it("opting out replaces the delivered refusal with the propose-parity lint alone", async () => {
    const result = await importBundle(
      bundle({ delivered: false, requirements: [], decisions: [] }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal.code).toBe("lint_blocked");
  });

  it("imports as approved with no external-delivery record when the bundle opts out", async () => {
    const receipt = await expectImported(bundle({ delivered: false }));

    const revisions = await harness.fixture.specs.listRevisions(
      receipt.spec.id,
    );
    expect(revisions[0]?.state).toBe("approved");
    expect(revisions[0]?.externalDelivery).toBeNull();
    expect(receipt.revision.externalDelivery).toBeNull();
  });
});

describe("a dry run validates the whole bundle and writes nothing (R6.1)", () => {
  it("returns the lint findings and the handle preview while leaving every table untouched", async () => {
    const before = dumpDatabase(harness.fixture);

    const preview = await expectPreviewed(
      bundle({
        dryRun: true,
        // An unanswered question is the deterministic advisory finding: it
        // proves a dry run reports findings rather than only counting them,
        // which an all-clean bundle's empty array could not show.
        questions: [
          { text: "Answered in the bundle?", answer: "Yes." },
          { text: "Which external formats are still out of scope?" },
        ],
      }),
    );

    expect(preview.blocking).toBe(0);
    expect(preview.findings).toEqual([
      {
        ruleId: "9.9.open-question",
        severity: "advisory",
        elementHandle: "Q2",
        message: "Q2 remains unresolved at propose.",
      },
    ]);
    expect(preview.counts).toEqual({
      sections: 2,
      requirements: 2,
      criteria: 3,
      decisions: 1,
      questions: 2,
      assumptions: 1,
    });
    expect(preview.handles).toEqual({
      requirements: [
        {
          handle: "R1",
          summary: "An agent imports an external spec in one shot.",
        },
        { handle: "R2", summary: "Import never satisfies a human gate." },
      ],
      criteria: [
        {
          handle: "R1.1",
          summary: "A valid bundle yields an approved design-stage revision.",
        },
        {
          handle: "R1.2",
          summary: "A refusal leaves no trace of the attempted spec.",
        },
        {
          handle: "R2.1",
          summary: "Zero approval rows exist after an import.",
        },
      ],
      decisions: [
        {
          handle: "D1",
          summary: "Import writes admissions, never approvals",
        },
      ],
      questions: [
        { handle: "Q1", summary: "Answered in the bundle?" },
        {
          handle: "Q2",
          summary: "Which external formats are still out of scope?",
        },
      ],
      assumptions: [
        { handle: "A1", summary: "The external source already shipped." },
      ],
    });

    expect(dumpDatabase(harness.fixture)).toEqual(before);
    expect(harness.published).toEqual([]);
    expect(
      await harness.fixture.specs.resolve(PROJECT_PATH, "imported-feature"),
    ).toBeNull();
  });

  /**
   * The preview is derived from the bundle's shape rather than from a counter,
   * so the only thing that can prove it honest is the real import that follows
   * it. Importing the same bundle immediately afterwards also shows the dry run
   * consumed no counter number: were the preview allocating, the real spec
   * would start at R3.
   */
  it("previews exactly the handles the real import goes on to allocate", async () => {
    const preview = await expectPreviewed();
    const receipt = await expectImported(bundle({ dryRun: false }));

    const snapshot = await harness.fixture.specs.getRevisionSnapshot(
      receipt.revision.id,
    );
    if (snapshot === null) {
      throw new Error("expected the imported revision to have a snapshot");
    }
    const handles = snapshot.elements.flatMap(({ element }) => {
      const handle = elementHandleInSnapshot(snapshot, element.id);
      return handle === null ? [] : [handle];
    });
    expect(handles).toEqual([
      ...preview.handles.requirements.flatMap((entry, index) => [
        entry.handle,
        ...preview.handles.criteria
          .filter(({ handle }) => handle.startsWith(`R${index + 1}.`))
          .map(({ handle }) => handle),
      ]),
      ...preview.handles.decisions.map(({ handle }) => handle),
    ]);

    expect(
      harness.review
        .findQuestionsBySpecId(receipt.spec.id)
        .map(({ number }) => `Q${number}`),
    ).toEqual(preview.handles.questions.map(({ handle }) => handle));
    expect(
      harness.review
        .findAssumptionsBySpecId(receipt.spec.id)
        .map(({ number }) => `A${number}`),
    ).toEqual(preview.handles.assumptions.map(({ handle }) => handle));
    expect(
      (await harness.fixture.specs.findCounter(receipt.spec.id, "R"))
        ?.lastNumber,
    ).toBe(2);
  });

  /**
   * A dry run reports the lint verdict rather than refusing on it. Refusing
   * would drop the preview exactly when the agent is still fixing the bundle
   * and most needs to see the numbering its cross-references will use.
   */
  it("reports a blocking finding without refusing, and still writes nothing", async () => {
    const before = dumpDatabase(harness.fixture);

    const preview = await expectPreviewed(
      bundle({
        dryRun: true,
        delivered: false,
        requirements: [
          {
            ref: "unreviewable",
            statement: "A requirement nothing can review.",
            priority: "must",
            risk: "high",
            criteria: [],
          },
        ],
        decisions: [],
      }),
    );

    expect(preview.blocking).toBe(1);
    expect(preview.findings.map(({ ruleId }) => ruleId)).toContain(
      "9.2.empty-spec",
    );
    expect(preview.handles.requirements).toEqual([
      { handle: "R1", summary: "A requirement nothing can review." },
    ]);
    expect(dumpDatabase(harness.fixture)).toEqual(before);
  });

  /**
   * The refusals a dry run inherits unchanged: each one decides the import is
   * impossible, so there is no numbering left to preview. A dry run that
   * disagreed with the real import about them would be worthless as a rehearsal.
   */
  it("refuses a taken slug, a dangling trace, and an invalid bundle exactly as the real import does", async () => {
    const existing = await expectImported();
    const before = dumpDatabase(harness.fixture);

    const taken = await importBundle(bundle({ dryRun: true }));
    expect(taken.ok).toBe(false);
    expect(taken.ok ? null : taken.refusal.code).toBe("slug_taken");
    expect(taken.ok ? null : taken.refusal.details?.existingSpecId).toBe(
      existing.spec.id,
    );

    const dangling = await importBundle(
      bundle({
        dryRun: true,
        slug: "another-feature",
        decisions: [
          {
            title: "Trace a requirement that is not in the bundle",
            chosenApproach: "Point at a ref nothing declares.",
            rejectedAlternatives: [],
            reason: "A dry run resolves references before it previews numbers.",
            traces: ["missing-requirement"],
          },
        ],
      }),
    );
    expect(dangling.ok ? null : dangling.refusal.code).toBe(
      "dangling_reference",
    );

    const invalid = await importBundle(
      bundle({ dryRun: true, slug: "another-feature", requirements: "none" }),
    );
    expect(invalid.ok ? null : invalid.refusal.code).toBe("validation");

    expect(dumpDatabase(harness.fixture)).toEqual(before);
  });
});
