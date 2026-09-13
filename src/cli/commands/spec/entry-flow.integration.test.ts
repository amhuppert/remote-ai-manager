import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createSpecEventsPublisher } from "@/lib/specs/events";
import { computeSpecMeasuresReport } from "@/lib/specs/measures";
import {
  createSpecRouteHandlers,
  createSpecWriteRouteHandlers,
  type SpecMutationServices,
  type SpecRouteDeps,
  type SpecWriteRouteDeps,
} from "@/lib/specs/route-handlers";
import { createAuthoringService } from "@/lib/specs/authoring-service";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const PROJECT_PATH = "/repos/native-entry";
const ELEMENT_FILE = "/tmp/native-entry-element.json";
const SECOND_ELEMENT_FILE = "/tmp/native-entry-second-element.json";
/**
 * The same element as a draft write. `spec create` and `spec draft` take
 * different documents — only the draft one states the version it replaces — so
 * one file cannot serve both verbs.
 */
const SECOND_DRAFT_FILE = "/tmp/native-entry-second-draft.json";
const BATCH_FILE = "/tmp/native-entry-batch.json";
const STALE_BATCH_FILE = "/tmp/native-entry-stale-batch.json";
const CURRENT_DETAIL_FILE = "/tmp/native-entry-current-detail.json";

/**
 * A batch that updates the created requirement and adds a criterion under it.
 * `baseElementVersion` is stated per element, so `stale` moves only the first
 * element's expectation while the second stays a create.
 */
function batchDocument(baseElementVersion: number): string {
  return JSON.stringify([
    {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "Audit events are durable and queryable.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion,
    },
    {
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: {
        kind: "criterion",
        text: "Every audit event survives a restart.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
    },
  ]);
}

const env: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "valid",
  CC_PROJECT: "demo",
  CC_SESSION: "authoring-session",
  CC_CONVERSATION_ID: "conversation-1",
};

const auth: AgentAuth = {
  async requireToken(request) {
    const result = await this.validateOptionalToken(request);
    return result.kind === "valid"
      ? null
      : Response.json({ error: "Invalid token" }, { status: 401 });
  },
  async validateOptionalToken(request) {
    return request.headers.get("authorization") === "Bearer valid"
      ? { kind: "valid" }
      : { kind: "invalid" };
  },
};

function requestFromFetch(url: string, init: FetchInit): Request {
  return new Request(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

describe("native /spec first-save visibility", () => {
  let db: Db;
  let host: CliHost;
  let written: Map<string, string>;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    written = new Map<string, string>();
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    const specs = createSpecsRepo(db, createWriteQueue());
    const review = createSpecReviewRepo(db);
    const links = createSpecLinksRepo(db);
    const eventRepo = createSpecEventsRepo(db);
    const events = createSpecEventsPublisher({
      appendInTransaction: eventRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
    const authoring = createAuthoringService({ specs, review, links, events });
    const services = { authoring } as unknown as SpecMutationServices;
    const writeDeps: SpecWriteRouteDeps = {
      auth,
      resolveProjectPath: async (name) =>
        name === "demo" ? PROJECT_PATH : null,
      resolveSpec: (projectPath, slug) => specs.resolve(projectPath, slug),
      listRevisions: (specId) => specs.listRevisions(specId),
      getRevisionSnapshot: (revisionId) =>
        specs.getRevisionSnapshot(revisionId),
      findQuestionsBySpecId: (specId) => review.findQuestionsBySpecId(specId),
      findAssumptionsBySpecId: (specId) =>
        review.findAssumptionsBySpecId(specId),
      findEventsBySpecId: (specId) => eventRepo.findBySpecId(specId),
      getServices: async () => services,
    };
    const readDeps: SpecRouteDeps = {
      readDeliveryReview: async () => null,
      resolveProjectPath: async (name) =>
        name === "demo" ? PROJECT_PATH : null,
      listSpecs: (projectPath) => specs.listByProject(projectPath),
      resolveSpec: (projectPath, slug) => specs.resolve(projectPath, slug),
      listAliases: (specId) => specs.listAliases(specId),
      listRevisions: (specId) => specs.listRevisions(specId),
      getRevisionSnapshot: (revisionId) =>
        specs.getRevisionSnapshot(revisionId),
      lintDraft: (specId, revisionId) =>
        authoring.lintDraft(specId, revisionId),
      findApprovalsBySpecId: review.findApprovalsBySpecId,
      findCommentsByRevision: () => [],
      findEventsBySpecId: (specId) => eventRepo.findBySpecId(specId),
      findGateAdmissionsBySpecId: review.findGateAdmissionsBySpecId,
      findLinksBySpecId: () => [],
      getLinkedTickets: async () => [],
      findQuestionsBySpecId: review.findQuestionsBySpecId,
      findAssumptionsBySpecId: review.findAssumptionsBySpecId,
      findExecutionsBySpecId: () => [],
      findWorkflowEventsByExecution: () => [],
      reconcileExecution: async (_projectPath, execution) => ({
        execution,
        workflowStatus: null,
      }),
      findCriterionDispositionsByExecution: () => [],
      findEvidenceByCriterionRevision: () => [],
      findProofVerdictsByCriterionRevision: () => [],
      findDeliveryVerdictsBySpecExecutionId: () => [],
      findExecutionBindingBySpecExecutionId: () => null,
      findWaiverForCriterionRevision: () => null,
      findWaiverById: () => null,
      findWaiversByRevision: () => [],
      exportSpec: async () => ({ markdownFiles: [], manifest: "{}\n" }),
      verifySpec: async () => ({
        ok: true,
        checkedRevisionIds: [],
        mismatches: [],
        consistencyFindings: [],
      }),
      measureProject: async () => computeSpecMeasuresReport([], []),
    };
    const writeHandlers = createSpecWriteRouteHandlers(writeDeps);
    const readHandlers = createSpecRouteHandlers(readDeps);
    host = {
      async fetch(url, init) {
        const parsed = new URL(url);
        const segments = parsed.pathname.split("/").filter(Boolean);
        const request = requestFromFetch(url, init);
        if (init.method === "POST" && segments.length === 5) {
          return writeHandlers.projectActionPOST(request, {
            params: Promise.resolve({
              name: segments[2] ?? "",
              action: segments[4] ?? "",
            }),
          });
        }
        if (init.method === "POST") {
          return writeHandlers.specActionPOST(request, {
            params: Promise.resolve({
              name: segments[2] ?? "",
              slug: segments[3] ?? "",
              action: segments[5] ?? "",
            }),
          });
        }
        if (segments.length === 3) {
          return readHandlers.listSpecsGET(request, {
            params: Promise.resolve({ name: segments[2] ?? "" }),
          });
        }
        if (segments[4] === "edit-context") {
          return readHandlers.getSpecEditContextGET(request, {
            params: Promise.resolve({
              name: segments[2] ?? "",
              slug: segments[3] ?? "",
            }),
          });
        }
        if (segments[4] === "outline") {
          return readHandlers.getSpecOutlineGET(request, {
            params: Promise.resolve({
              name: segments[2] ?? "",
              slug: segments[3] ?? "",
            }),
          });
        }
        return readHandlers.getSpecGET(request, {
          params: Promise.resolve({
            name: segments[2] ?? "",
            slug: segments[3] ?? "",
          }),
        });
      },
      async readTextFile(filePath) {
        if (filePath === ELEMENT_FILE) {
          return JSON.stringify({
            elementId: "requirement-1",
            kind: "requirement",
            parentElementId: null,
            position: 0,
            payload: {
              kind: "requirement",
              statement: "Audit events are durable.",
              priority: "must",
              risk: "high",
            },
          });
        }
        if (filePath === BATCH_FILE) return batchDocument(1);
        if (filePath === STALE_BATCH_FILE) return batchDocument(7);
        if (
          filePath === SECOND_ELEMENT_FILE ||
          filePath === SECOND_DRAFT_FILE
        ) {
          return JSON.stringify({
            elementId: "requirement-2",
            kind: "requirement",
            parentElementId: null,
            position: 1,
            ...(filePath === SECOND_DRAFT_FILE
              ? { baseElementVersion: null }
              : {}),
            payload: {
              kind: "requirement",
              statement: "Audit events are queryable.",
              priority: "must",
              risk: "medium",
            },
          });
        }
        return null;
      },
      async readFileBytes() {
        return null;
      },
      async writeTextFile(filePath, content) {
        written.set(filePath, content);
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
  });

  afterEach(() => db.close());

  function createArgs(extra: string[] = []): string[] {
    return [
      "spec",
      "create",
      "--slug",
      "audit-log",
      "--name",
      "Audit Log",
      "--preset",
      "contract-bearing",
      ...extra,
    ];
  }

  async function listedSpecs(): Promise<unknown> {
    const listed = await runCli(["spec", "list", "--json"], env, host);
    expect(listed.exitCode).toBe(0);
    return JSON.parse(listed.stdout);
  }

  it("creates the durable spec object from the first successful draft save", async () => {
    expect(await listedSpecs()).toMatchObject({ specs: [] });

    const created = await runCli(
      createArgs(["--file", ELEMENT_FILE, "--json"]),
      env,
      host,
    );
    expect(created.exitCode).toBe(0);
    const envelope = JSON.parse(created.stdout) as {
      created: {
        spec: { createdAt: string };
        version: { createdAt: string; elementVersion: number };
      };
    };
    // The spec object is born from the first draft save itself.
    expect(envelope.created.version.elementVersion).toBe(1);
    expect(envelope.created.spec.createdAt).toBe(
      envelope.created.version.createdAt,
    );

    expect(await listedSpecs()).toMatchObject({
      specs: [{ spec: { slug: "audit-log" }, phase: { primary: "draft" } }],
    });
    const shown = await runCli(
      ["spec", "show", "audit-log", "--json"],
      env,
      host,
    );
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      view: "outline",
      spec: { slug: "audit-log" },
      requirements: [
        {
          elementId: "requirement-1",
          summary: "Audit events are durable.",
        },
      ],
    });
  });

  it("refuses the elementless create form and leaves no durable spec behind", async () => {
    const created = await runCli(createArgs(), env, host);

    expect(created.exitCode).toBe(2);
    expect(created.stderr).toContain("--file");
    expect(await listedSpecs()).toMatchObject({ specs: [] });
  });

  it("refuses a taken slug with a typed slug_taken refusal", async () => {
    const first = await runCli(createArgs(["--file", ELEMENT_FILE]), env, host);
    expect(first.exitCode).toBe(0);

    const second = await runCli(
      createArgs(["--file", SECOND_ELEMENT_FILE, "--json"]),
      env,
      host,
    );
    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: false,
      code: "slug_taken",
    });
    expect(await listedSpecs()).toMatchObject({
      specs: [{ spec: { slug: "audit-log" } }],
    });
  });

  it("names the globally reused element ID and its owning spec", async () => {
    const first = await runCli(createArgs(["--file", ELEMENT_FILE]), env, host);
    expect(first.exitCode).toBe(0);

    const second = await runCli(
      [
        "spec",
        "create",
        "--slug",
        "billing-log",
        "--name",
        "Billing Log",
        "--preset",
        "contract-bearing",
        "--file",
        ELEMENT_FILE,
        "--json",
      ],
      env,
      host,
    );

    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'Spec element ID "requirement-1" is already used by spec',
      ),
      code: "element_id_taken",
      issues: [
        {
          path: "unmetConditions[0]",
          message: expect.stringContaining("element IDs are globally unique"),
        },
      ],
      details: {
        elementId: "requirement-1",
        existingSpecId: expect.any(String),
      },
      instruction: expect.stringContaining("<spec-slug>-requirement-1"),
    });
    expect(await listedSpecs()).toMatchObject({
      specs: [{ spec: { slug: "audit-log" } }],
    });
  });

  it("reopens the spec's editable draft through spec amend", async () => {
    const created = await runCli(
      createArgs(["--file", ELEMENT_FILE]),
      env,
      host,
    );
    expect(created.exitCode).toBe(0);

    const amended = await runCli(
      ["spec", "amend", "audit-log", "--json"],
      env,
      host,
    );

    expect(amended.exitCode).toBe(0);
    // openAmendment is idempotent: an already-open draft comes back unchanged.
    expect(JSON.parse(amended.stdout)).toMatchObject({
      ok: true,
      revision: { number: 1, state: "draft", authoringStage: "requirements" },
    });
  });

  it("keeps subsequent element-granular draft saves landing in the created spec", async () => {
    const created = await runCli(
      createArgs(["--file", ELEMENT_FILE]),
      env,
      host,
    );
    expect(created.exitCode).toBe(0);

    const drafted = await runCli(
      ["spec", "draft", "audit-log", "--file", SECOND_DRAFT_FILE],
      env,
      host,
    );
    expect(drafted.exitCode).toBe(0);

    const shown = await runCli(
      ["spec", "show", "audit-log", "--json"],
      env,
      host,
    );
    expect(shown.exitCode).toBe(0);
    const body = JSON.parse(shown.stdout) as {
      requirements: Array<{ summary: string }>;
    };
    expect(body.requirements.map(({ summary }) => summary)).toEqual([
      "Audit events are durable.",
      "Audit events are queryable.",
    ]);
  });

  async function currentElementIds(): Promise<string[]> {
    const shown = await runCli(
      [
        "spec",
        "show",
        "audit-log",
        "--full",
        "--out",
        CURRENT_DETAIL_FILE,
        "--json",
      ],
      env,
      host,
    );
    expect(shown.exitCode).toBe(0);
    const body = JSON.parse(written.get(CURRENT_DETAIL_FILE) ?? "null") as {
      currentRevision: {
        elements: Array<{ element: { id: string } }>;
      } | null;
    };
    return (
      body.currentRevision?.elements.map(({ element }) => element.id) ?? []
    );
  }

  it("lands an array --file as one batch of element-granular writes", async () => {
    expect(
      (await runCli(createArgs(["--file", ELEMENT_FILE]), env, host)).exitCode,
    ).toBe(0);

    const batched = await runCli(
      ["spec", "draft", "audit-log", "--file", BATCH_FILE, "--json"],
      env,
      host,
    );

    expect(batched.exitCode).toBe(0);
    expect(JSON.parse(batched.stdout).batch.written).toMatchObject([
      {
        index: 0,
        elementId: "requirement-1",
        handle: "R1",
        version: { elementVersion: 2 },
      },
      {
        index: 1,
        elementId: "criterion-1",
        handle: "R1.1",
        version: { elementVersion: 1 },
      },
    ]);
    expect(await currentElementIds()).toEqual(["requirement-1", "criterion-1"]);
  });

  it("refuses the whole batch when one element's base version is stale and writes nothing", async () => {
    expect(
      (await runCli(createArgs(["--file", ELEMENT_FILE]), env, host)).exitCode,
    ).toBe(0);

    const refused = await runCli(
      ["spec", "draft", "audit-log", "--file", STALE_BATCH_FILE],
      env,
      host,
    );

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "elements[0] requirement-1: stale_element",
    );
    expect(refused.stderr).toContain("element is at version 1");
    // All-or-nothing: the second element was a legal create and still must not
    // survive the refusal.
    expect(await currentElementIds()).toEqual(["requirement-1"]);
  });
});
