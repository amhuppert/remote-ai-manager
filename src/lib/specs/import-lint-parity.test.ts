import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";

import { createAuthoringService } from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { createImportService } from "./import-service";
import type { Refusal } from "./schemas";

/**
 * An import is a propose and an approval collapsed into one act, so it owes the
 * lint an authored propose owes. These tests are the cross-path proof: the same
 * content is put through native authoring's propose and through import, and the
 * two refusals are compared field for field. A drift that let an import approve
 * a revision propose would have refused fails here rather than in production.
 *
 * Both specs carry the same slug in different projects on purpose. The
 * `9.2.empty-spec` finding addresses the spec by its slug, so any other pairing
 * would differ in `elementHandle` and force a comparison loose enough to miss a
 * real divergence.
 */
const SLUG = "parity-feature";
const AUTHORED_PROJECT = "/repos/parity-authored";
const IMPORTED_PROJECT = "/repos/parity-imported";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-parity-1",
} as const;

/** A requirement with no criterion — nothing to review, so propose blocks. */
const UNREVIEWABLE_STATEMENT = "A requirement nothing can review.";

interface Harness {
  readonly fixture: ReturnType<typeof createPersistenceFixture>;
  readonly authoring: ReturnType<typeof createAuthoringService>;
  readonly imports: ReturnType<typeof createImportService>;
}

let harness: Harness;

function bundle(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: SLUG,
    name: "Parity Feature",
    source: { label: "kiro:.kiro/specs/parity-feature" },
    // Opted out of the delivered marking so the bundle reaches the lint at all:
    // a criteria-less bundle claiming delivery is refused before the first
    // write, which would prove nothing about lint parity.
    delivered: false,
    sections: [],
    requirements: [
      {
        statement: UNREVIEWABLE_STATEMENT,
        priority: "must",
        risk: "high",
        criteria: [],
      },
    ],
    decisions: [],
    questions: [],
    assumptions: [],
    ...overrides,
  };
}

beforeEach(() => {
  const fixture = createPersistenceFixture();
  fixture.seedProject(AUTHORED_PROJECT);
  fixture.seedProject(IMPORTED_PROJECT);
  const eventRows = createSpecEventsRepo(fixture.db);
  const review = createSpecReviewRepo(fixture.db);
  const links = createSpecLinksRepo(fixture.db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventRows.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  let ids = 0;
  let times = 0;
  const shared = {
    specs: fixture.specs,
    review,
    links,
    events,
    newId(prefix: string) {
      ids += 1;
      return `${prefix}-${ids}`;
    },
    now() {
      times += 1;
      return `2026-08-11T11:00:${String(times).padStart(2, "0")}.000Z`;
    },
  };
  harness = {
    fixture,
    authoring: createAuthoringService(shared),
    imports: createImportService(shared),
  };
});

afterEach(() => harness.fixture.close());

/** The refusal native authoring produces when the same content is proposed. */
async function proposeRefusal(): Promise<Refusal> {
  const created = await harness.authoring.createSpec({
    projectPath: AUTHORED_PROJECT,
    slug: SLUG,
    name: "Parity Feature",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: UNREVIEWABLE_STATEMENT,
        priority: "must",
        risk: "high",
      },
    },
    actor: AGENT,
  });
  await harness.fixture.specs.advanceDraftAuthoringStage({
    specId: created.spec.id,
    revisionId: created.draft.id,
    expectedStage: "requirements",
    targetStage: "design",
  });
  const result = await harness.authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: AGENT,
  });
  if (result.ok) {
    throw new Error("expected the authored propose to be refused by lint");
  }
  return result.refusal;
}

function importSpec(input: unknown = bundle()) {
  return harness.imports.importSpec({
    projectPath: IMPORTED_PROJECT,
    bundle: input,
    actor: AGENT,
  });
}

describe("a real import enforces propose's blocking-lint bar (R6.2)", () => {
  it("refuses with the code, unmet conditions, and findings an authored propose refuses with", async () => {
    const proposed = await proposeRefusal();

    const result = await importSpec();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the import to be refused by lint");
    expect(result.refusal.code).toBe(proposed.code);
    expect(result.refusal.unmetConditions).toEqual(proposed.unmetConditions);
    // The findings themselves, not a summary of them: an agent's remediation
    // loop reads this array identically whichever act produced it.
    expect(result.refusal.findings).toEqual(proposed.findings);
    expect(result.refusal.findings).toEqual([
      {
        ruleId: "9.2.empty-spec",
        severity: "blocks_propose",
        elementHandle: SLUG,
        message: "Empty spec — nothing to review.",
      },
      {
        ruleId: "9.13.design-stage-without-design-content",
        severity: "advisory",
        elementHandle: SLUG,
        message:
          "Design-stage revision carries no decision or design narrative elements.",
      },
    ]);
    // The one additive difference between the two envelopes, pinned so a reader
    // sees it was weighed rather than missed: an import also reports how many
    // findings it saw. That is metadata about the refusal, not about the
    // findings, so the loop reading `findings` is unaffected by it.
    expect(result.refusal.details).toEqual({ findingCount: 2 });
    expect(proposed.details).toBeUndefined();
  });

  /**
   * The one field that must differ. Both instructions name the act the caller
   * actually performed, so telling an importing agent to re-run `cctl spec
   * propose` would send it to a spec that does not exist.
   */
  it("names the import retry rather than the propose retry in its instruction", async () => {
    const proposed = await proposeRefusal();

    const result = await importSpec();

    if (result.ok) throw new Error("expected the import to be refused by lint");
    expect(result.refusal.instruction).toContain("cctl spec import");
    expect(proposed.instruction).toContain("cctl spec propose");
  });

  it("leaves no spec behind, so an import can never approve what propose refused", async () => {
    const result = await importSpec();

    expect(result.ok).toBe(false);
    expect(await harness.fixture.specs.resolve(IMPORTED_PROJECT, SLUG)).toBe(
      null,
    );
  });

  /**
   * Severity grouping is what makes the two arrays interchangeable: a finding
   * that blocks propose must block import, and one that does not must block
   * neither. An advisory alongside a blocking finding proves the import
   * refuses on the blocking one alone while still reporting both, ranked.
   */
  it("reports advisories alongside the blocking finding in propose's severity order", async () => {
    const result = await importSpec(
      bundle({ questions: [{ text: "Still unresolved at propose?" }] }),
    );

    if (result.ok) throw new Error("expected the import to be refused by lint");
    expect(
      result.refusal.findings?.map((finding) =>
        typeof finding === "object" && finding !== null && "severity" in finding
          ? finding.severity
          : null,
      ),
    ).toEqual(["blocks_propose", "advisory", "advisory"]);
    expect(result.refusal.unmetConditions).toEqual([
      "Empty spec — nothing to review.",
    ]);
  });
});

describe("a dry run applies the identical lint (R6.1, R6.2)", () => {
  it("previews the findings the real import then refuses with", async () => {
    const preview = await importSpec(bundle({ dryRun: true }));
    const real = await importSpec();

    if (!preview.ok) {
      throw new Error(
        `expected the dry run to be admitted, refused: ${JSON.stringify(preview.refusal)}`,
      );
    }
    if (!preview.dryRun) throw new Error("expected a dry-run preview");
    if (real.ok) throw new Error("expected the real import to be refused");

    expect(preview.preview.findings).toEqual(real.refusal.findings);
    expect(preview.preview.blocking).toBe(1);
    expect(
      preview.preview.findings
        .filter(({ severity }) => severity === "blocks_propose")
        .map(({ message }) => message),
    ).toEqual(real.refusal.unmetConditions);
  });
});
