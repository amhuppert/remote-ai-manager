import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createSpecRouteHandlers,
  type SpecRouteDeps,
} from "@/lib/specs/route-handlers";
import {
  loadSpecExportState,
  renderCanonicalBundle,
  verifyExportState,
} from "@/lib/specs/export";
import { stableStringify } from "@/lib/shared/stable-stringify";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionCitationHash,
  createSpecsRepo,
} from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecGateAdmissionRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import {
  artifactTextOf,
  inlineDataOf,
  runCcWithHost,
} from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

const PROJECT_PATH = "/repos/demo";
const CREATED_AT = "2026-07-18T00:00:00.000Z";

const spec: Spec = {
  id: "spec-1",
  projectPath: PROJECT_PATH,
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const revision: SpecRevision = {
  id: "revision-1",
  specId: spec.id,
  number: 1,
  state: "draft",
  authoringStage: "plan",
  basedOnRevisionId: null,
  contentHash: null,
  citationContractVersion: 2,
  citationVersion: 1,
  citationHash: "0".repeat(64),
  proposedAt: null,
  approvedAt: null,
  createdAt: CREATED_AT,
};

const snapshot: SpecRevisionSnapshot = {
  revision,
  assumptionCitations: [],
  elements: [
    {
      element: {
        id: "requirement-1",
        specId: spec.id,
        kind: "requirement",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "requirement-1",
        position: 0,
        payload: {
          kind: "requirement",
          statement: "Specs are durable product objects.",
          priority: "must",
          risk: "high",
        },
        payloadHash: "requirement-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "criterion-1",
        specId: spec.id,
        kind: "criterion",
        number: 1,
        parentElementId: "requirement-1",
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "criterion-1",
        position: 1,
        payload: {
          kind: "criterion",
          text: "The spec can be read through cctl.",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "task-1",
        specId: spec.id,
        kind: "task",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-1",
        position: 2,
        payload: {
          kind: "task",
          title: "Build the CLI reads",
          instructions: "Expose every approved read verb.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
          laneGroup: "cli",
          executionLane: "cli-surface",
          touchedPaths: ["src/cli/commands/spec"],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "task-2",
        specId: spec.id,
        kind: "task",
        number: 2,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-2",
        position: 3,
        payload: {
          kind: "task",
          title: "Verify the CLI reads",
          instructions: "Exercise every graph fact through the read contract.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: ["task-1"],
          laneGroup: "cli",
          executionLane: "cli-surface",
          touchedPaths: ["src/cli/commands/spec/read.contract.test.ts"],
        },
        payloadHash: "task-2-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
  ],
};

const question: SpecQuestionRow = {
  id: "question-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "Which export format is canonical?",
  provenance_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-1",
  }),
  record_version: 1,
  status: "open",
  answer: null,
  answered_at: null,
  withdrawn_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const assumption: SpecAssumptionRow = {
  id: "assumption-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "SQLite remains authoritative.",
  proposed_by_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-1",
  }),
  record_version: 1,
  disposition: "proposed",
  disposed_at: null,
  withdrawn_at: null,
  supersedes_assumption_id: null,
  supersession_operation_id: null,
  supersession_request_hash: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const canonicalSnapshot: SpecRevisionSnapshot = {
  revision: {
    ...revision,
    citationHash: computeSpecRevisionCitationHash(
      revision.citationContractVersion,
      [],
    ),
  },
  assumptionCitations: [],
  elements: snapshot.elements.slice(0, 3).map((row) => ({
    ...row,
    version: {
      ...row.version,
      payloadHash: computeSpecElementPayloadHash(row.version.payload),
    },
  })),
};

const bundle = renderCanonicalBundle({
  spec,
  revisions: [{ snapshot: canonicalSnapshot }],
  approvals: [],
  gateAdmissions: [],
  questions: [],
  assumptions: [],
  attentionAuditEvents: [],
});

function createDeps(): SpecRouteDeps {
  return {
    async resolveProjectPath(name) {
      return name === "demo" ? PROJECT_PATH : null;
    },
    async listSpecs() {
      return [spec];
    },
    async resolveSpec(_projectPath, slug) {
      return slug === spec.slug ? spec : null;
    },
    async listAliases() {
      return [];
    },
    async listRevisions() {
      return [revision];
    },
    async getRevisionSnapshot(revisionId) {
      return revisionId === revision.id ? snapshot : null;
    },
    async lintDraft() {
      return [];
    },
    findApprovalsBySpecId() {
      return [] as SpecApprovalRow[];
    },
    findCommentsByRevision() {
      return [];
    },
    findEventsBySpecId() {
      return [];
    },
    findGateAdmissionsBySpecId() {
      return [] as SpecGateAdmissionRow[];
    },
    findLinksBySpecId() {
      return [];
    },
    async getLinkedTickets() {
      return [];
    },
    findQuestionsBySpecId() {
      return [question];
    },
    findAssumptionsBySpecId() {
      return [assumption];
    },
    async exportSpec() {
      return bundle;
    },
    async verifySpec() {
      return {
        ok: true,
        checkedRevisionIds: [revision.id],
        mismatches: [],
        consistencyFindings: [],
      };
    },
  };
}

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

describe("cctl spec read verbs against seeded read routes", () => {
  /**
   * The reviewer-facing changelog. Its default pair is not a free choice: Spec
   * Studio's review cards diff the current revision against `basedOnRevisionId`,
   * so a CLI that defaulted to the governance base would classify the same
   * review differently from the surface a human signs off on.
   */
  describe("cctl spec diff", () => {
    it("surfaces the validation paths when a 2xx body fails this CLI's schema", async () => {
      // The body shape that shipped command-center#91: a citation-change kind
      // leaked into `classification`. A server that drifts this way again must
      // produce a failure naming the refusing path, not a build-skew claim.
      const driftedHost: CliHost = {
        fetch: async () =>
          new Response(
            JSON.stringify({
              slug: "native-sdd",
              baseline: "review",
              from: null,
              to: { revisionId: "revision-1", number: 1, state: "draft" },
              elements: [
                {
                  elementId: "decision-1",
                  handle: "D1",
                  kind: "decision",
                  classification: "citation_added",
                  directlyChanged: true,
                  summary: "Added assumption A1 citation to decision-1.",
                },
              ],
              planStale: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        readTextFile: async () => null,
        readFileBytes: async () => null,
        sleep: async () => {},
        platform: "darwin",
        homedir: "/Users/test",
      };

      const result = await runCcWithHost(
        ["spec", "diff", "native-sdd"],
        baseEnv,
        driftedHost,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CC_INVALID_RESPONSE");
      expect(result.stderr).toContain("classification");
      expect(result.stderr).not.toContain("same build as this CLI");
    });
  });
});

/**
 * The export -> verify contract, persistence-backed (design.md §6): a real
 * SQLite world seeded through raw rows, and the real export/verify boundary
 * behind the real routes — not simulated bundles.
 */
describe("cctl spec verify --against on a persisted spec", () => {
  const LEGACY_PROJECT = "/repos/legacy-cli";
  const CLEAN_SPEC_ID = "spec-clean-cli";
  const CLEAN_REVISION_ID = "revision-clean-cli";
  const AT = "2026-07-01T00:00:00.000Z";

  interface LegacyElement {
    id: string;
    kind: "requirement" | "criterion";
    number: number;
    parentElementId: string | null;
    position: number;
    payload: Record<string, unknown>;
  }

  const CLEAN_ELEMENTS: LegacyElement[] = [
    {
      id: "requirement-clean",
      kind: "requirement",
      number: 1,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "Untouched specs keep matching their old bundles.",
        priority: "must",
        risk: "low",
      },
    },
    {
      id: "criterion-clean",
      kind: "criterion",
      number: 1,
      parentElementId: "requirement-clean",
      position: 1,
      payload: {
        kind: "criterion",
        text: "The clean bundle round-trips.",
        validationStrategy: { kinds: ["test_run"] },
      },
    },
  ];

  function sha256(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
  }

  function contentHashOf(elements: readonly LegacyElement[]): string {
    return sha256({
      authoringStage: "plan",
      elements: elements.map((element) => ({
        elementId: element.id,
        kind: element.kind,
        number: element.number,
        parentElementId: element.parentElementId,
        position: element.position,
        payload: element.payload,
      })),
    });
  }

  type Db = ReturnType<typeof _createTestDb>;
  const openDbs: Db[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  function seedLegacyCliWorld(): Db {
    const db = _createTestDb({ inMemory: true });
    openDbs.push(db);
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
      LEGACY_PROJECT,
    );
    const insertSpec = db.prepare(
      `INSERT INTO specs (
         id, project_path, slug, name, gate_policy_json,
         abandoned_at, abandoned_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '{"preset":"contract-bearing"}', NULL, NULL, ?, ?)`,
    );
    insertSpec.run(
      CLEAN_SPEC_ID,
      LEGACY_PROJECT,
      "clean-spec",
      "Clean spec",
      AT,
      AT,
    );
    const insertRevision = db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, authoring_stage, based_on_revision_id,
         content_hash, proposed_at, approved_at, created_at
       ) VALUES (?, ?, 1, 'approved', 'plan', NULL, ?, ?, ?, ?)`,
    );
    insertRevision.run(
      CLEAN_REVISION_ID,
      CLEAN_SPEC_ID,
      contentHashOf(CLEAN_ELEMENTS),
      AT,
      AT,
      AT,
    );
    const insertElement = db.prepare(
      `INSERT INTO spec_elements (
         id, spec_id, kind, number, parent_element_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO spec_element_versions (
         revision_id, element_id, position, payload_json, payload_hash,
         element_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const [specId, revisionId, elements] of [
      [CLEAN_SPEC_ID, CLEAN_REVISION_ID, CLEAN_ELEMENTS],
    ] as const) {
      for (const element of elements) {
        insertElement.run(
          element.id,
          specId,
          element.kind,
          element.number,
          element.parentElementId,
          AT,
        );
        insertVersion.run(
          revisionId,
          element.id,
          element.position,
          stableStringify(element.payload),
          sha256(element.payload),
          AT,
          AT,
        );
      }
    }
    return db;
  }

  function makePersistenceHost(
    db: Db,
    files: Map<string, string>,
  ): CliHost & {
    requests: RecordedRequest[];
  } {
    const specs = createSpecsRepo(db, createWriteQueue());
    const review = createSpecReviewRepo(db);
    const exportDeps = {
      specs,
      review,
      events: createSpecEventsRepo(db),
    };
    const handlers = createSpecRouteHandlers({
      ...createDeps(),
      async resolveProjectPath(name) {
        return name === "demo" ? LEGACY_PROJECT : null;
      },
      listSpecs: () => specs.listByProject(LEGACY_PROJECT),
      async resolveSpec(_projectPath, slug) {
        const all = await specs.listByProject(LEGACY_PROJECT);
        return all.find((candidate) => candidate.slug === slug) ?? null;
      },
      async exportSpec(specId) {
        return renderCanonicalBundle(
          await loadSpecExportState(exportDeps, specId),
        );
      },
      async verifySpec(specId) {
        return verifyExportState(await loadSpecExportState(exportDeps, specId));
      },
    });

    const requests: RecordedRequest[] = [];
    return {
      requests,
      async fetch(url, init) {
        requests.push({ url, init });
        const segments = new URL(url).pathname.split("/").filter(Boolean);
        const name = decodeURIComponent(segments[2] ?? "");
        const slug = decodeURIComponent(segments[3] ?? "");
        const tail = segments[4];
        const request = new Request(url, {
          method: init.method,
          headers: init.headers,
        });
        const context = { params: Promise.resolve({ name, slug }) };
        if (tail === "export") {
          return handlers.getSpecExportGET(request, context);
        }
        if (tail === "verify") {
          return handlers.getSpecVerifyGET(request, context);
        }
        throw new Error(`unexpected route in migration contract test: ${url}`);
      },
      async readTextFile(filePath) {
        return files.get(filePath) ?? null;
      },
      async readFileBytes() {
        return null;
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
  }

  const bundleShapeSchema = z
    .object({
      markdownFiles: z.array(
        z.object({ path: z.string(), content: z.string() }).strict(),
      ),
      manifest: z.string(),
    })
    .strict();

  const manifestShapeSchema = z
    .object({
      formatVersion: z.number(),
      revisions: z.array(
        z
          .object({
            contentHash: z.string().nullable(),
            elements: z.array(
              z.object({ id: z.string(), payloadHash: z.string() }).loose(),
            ),
          })
          .loose(),
      ),
    })
    .loose();

  /**
   * The 2026-08-07 default flip moved the bundle from stdout into a file. The
   * bundle format did not move with it: a file this default writes has to be
   * the same bytes `verify --against` already accepts, or every stored export
   * would read as a mismatch on the next CC build.
   */
  it("accepts the bundle the default export writes, unchanged, at verify --against", async () => {
    const db = seedLegacyCliWorld();
    const files = new Map<string, string>();
    const host = makePersistenceHost(db, files);

    const exported = await runCcWithHost(
      ["spec", "export", "clean-spec", "--json"],
      baseEnv,
      host,
    );
    expect(exported.exitCode, exported.stderr).toBe(0);
    const artifact = exported.artifacts[0];
    if (!artifact) throw new Error("default export wrote nothing");
    const summary = { path: artifact.path };
    const written = artifactTextOf(exported);
    const manifest = manifestShapeSchema.parse(
      JSON.parse(bundleShapeSchema.parse(JSON.parse(written)).manifest),
    );
    expect(manifest.revisions).toHaveLength(1);
    expect(manifest.revisions[0]?.elements).toHaveLength(2);

    files.set(summary.path, written);
    const verified = await runCcWithHost(
      ["spec", "verify", "clean-spec", "--against", summary.path, "--json"],
      baseEnv,
      host,
    );

    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(inlineDataOf(verified)).toMatchObject({
      against: summary.path,
    });
  });
});
