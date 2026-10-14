import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecEventsPublisher } from "./events";
import {
  loadSpecExportState,
  renderVerifiedCanonicalBundle,
  verifyExportState,
} from "./export";
import { createImportService, type ImportService } from "./import-service";
import { createSpecRouteHandlers } from "./route-handlers";
import {
  specDetailViewSchema,
  specInventoryViewSchema,
  specStatusViewSchema,
} from "./view-schemas";

const PROJECT_PATH = "/repos/import-provenance";
const SLUG = "imported-feature";
const bundle = {
  slug: SLUG,
  name: "Imported feature",
  source: { label: "kiro:.kiro/specs/feature" },
  sections: [
    {
      role: "intent_problem",
      title: "Problem",
      body: "Preserve the external source.",
    },
  ],
  requirements: [
    {
      ref: "provenance",
      statement: "Imported content preserves its source.",
      priority: "must",
      risk: "medium",
      criteria: [
        {
          text: "The spec reports its source and import admissions.",
          validationStrategy: { kinds: ["test_run"] },
        },
      ],
    },
  ],
  decisions: [],
  questions: [],
  assumptions: [],
};

let fixture: PersistenceFixture;
let service: ImportService;
let handlers: ReturnType<typeof createSpecRouteHandlers>;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const specs = fixture.specs;
  const review = createSpecReviewRepo(fixture.db);
  const links = createSpecLinksRepo(fixture.db);
  const events = createSpecEventsRepo(fixture.db);
  service = createImportService({
    specs,
    review,
    links,
    events: createSpecEventsPublisher({
      appendInTransaction: events.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
  });
  const exportDeps = { specs, review, events };
  handlers = createSpecRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    listSpecs: (path) => specs.listByProject(path),
    resolveSpec: (path, slug) => specs.resolve(path, slug),
    listAliases: (id) => specs.listAliases(id),
    listRevisions: (id) => specs.listRevisions(id),
    getRevisionSnapshot: (id) => specs.getRevisionSnapshot(id),
    lintDraft: async () => [],
    findApprovalsBySpecId: (id) => review.findApprovalsBySpecId(id),
    findCommentsByRevision: (id) => review.findCommentsByRevision(id),
    findEventsBySpecId: (id) => events.findBySpecId(id),
    findGateAdmissionsBySpecId: (id) => review.findGateAdmissionsBySpecId(id),
    findLinksBySpecId: (id) => links.findBySpecId(id),
    getLinkedTickets: async () => [],
    findQuestionsBySpecId: (id) => review.findQuestionsBySpecId(id),
    findAssumptionsBySpecId: (id) => review.findAssumptionsBySpecId(id),
    exportSpec: async (id) =>
      renderVerifiedCanonicalBundle(await loadSpecExportState(exportDeps, id)),
    verifySpec: async (id) =>
      verifyExportState(await loadSpecExportState(exportDeps, id)),
  });
});

afterEach(() => fixture.close());

async function importSpec() {
  const result = await service.importSpec({
    projectPath: PROJECT_PATH,
    bundle,
    actor: { kind: "agent", conversationId: "conversation-import" },
  });
  if (!result.ok || result.dryRun) throw new Error("Expected an imported spec");
  return result.value;
}

const request = () =>
  new Request("http://cc.test/api/specs/demo/imported-feature");
const context = () => ({
  params: Promise.resolve({ name: "demo", slug: SLUG }),
});

describe("import provenance through authoring views", () => {
  it("reports an approved imported spec with no human approvals", async () => {
    await importSpec();
    const status = specStatusViewSchema.parse(
      await (await handlers.getSpecStatusGET(request(), context())).json(),
    );
    expect(status.phase.primary).toBe("approved");
    expect(status.imported).toBe(true);
    expect(status.revisionSignOff?.approval ?? null).toBeNull();
    const detail = specDetailViewSchema.parse(
      await (await handlers.getSpecGET(request(), context())).json(),
    );
    expect(detail.approvals).toEqual([]);
    expect(detail.gateAdmissions).toHaveLength(2);
    // Both admissions share the import's single clock read, so their
    // chronological order is not defined between them.
    expect(
      detail.gateAdmissions.map(({ gate, basis, approvalId }) => ({
        gate,
        basis,
        approvalId,
      })),
    ).toEqual(
      expect.arrayContaining([
        { gate: "requirements", basis: "import", approvalId: null },
        { gate: "design", basis: "import", approvalId: null },
      ]),
    );
  });

  it("reports source and counts from the durable import event", async () => {
    const imported = await importSpec();
    const detail = specDetailViewSchema.parse(
      await (await handlers.getSpecGET(request(), context())).json(),
    );
    expect(detail.importRecord).toMatchObject({
      sourceLabel: bundle.source.label,
      counts: {
        sections: 1,
        requirements: 1,
        criteria: 1,
        decisions: 0,
        questions: 0,
        assumptions: 0,
      },
    });
    for (const admission of detail.gateAdmissions) {
      expect(admission.revisionId).toBe(imported.revision.id);
      expect(admission.createdAt).toBe(detail.importRecord?.occurredAt);
    }
  });

  it("carries import provenance into the inventory", async () => {
    await importSpec();
    const response = await handlers.listSpecsGET(request(), {
      params: Promise.resolve({ name: "demo" }),
    });
    const inventory = specInventoryViewSchema.parse(await response.json());
    expect(inventory.specs).toMatchObject([
      { imported: true, phase: { primary: "approved" } },
    ]);
  });
});
