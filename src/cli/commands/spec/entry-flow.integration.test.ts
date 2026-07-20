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

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
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
      getServices: async () => services,
    };
    const readDeps: SpecRouteDeps = {
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
      findGateAdmissionsByRevision: review.findGateAdmissionsByRevision,
      findLinksBySpecId: () => [],
      getLinkedTickets: async () => [],
      findQuestionsBySpecId: review.findQuestionsBySpecId,
      findAssumptionsBySpecId: review.findAssumptionsBySpecId,
      findExecutionsBySpecId: () => [],
      findTaskClaimsBySpecId: () => [],
      findWorkflowEventsByExecution: () => [],
      reconcileExecution: async (_projectPath, execution) => execution,
      ingestExecutionEvidenceBestEffort: async () => undefined,
      findCriterionDispositionsByExecution: () => [],
      findEvidenceByCriterionRevision: () => [],
      findProofVerdictsByCriterionRevision: () => [],
      findWaiverForCriterionRevision: () => null,
      exportSpec: async () => ({ markdownFiles: [], manifest: "{}\n" }),
      verifySpec: async () => ({
        ok: true,
        checkedRevisionIds: [],
        mismatches: [],
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
        if (filePath === SECOND_ELEMENT_FILE) {
          return JSON.stringify({
            elementId: "requirement-2",
            kind: "requirement",
            parentElementId: null,
            position: 1,
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
      spec: {
        spec: { slug: "audit-log" },
        currentRevision: {
          elements: [
            {
              version: {
                payload: { statement: "Audit events are durable." },
              },
            },
          ],
        },
      },
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

  it("keeps subsequent element-granular draft saves landing in the created spec", async () => {
    const created = await runCli(
      createArgs(["--file", ELEMENT_FILE]),
      env,
      host,
    );
    expect(created.exitCode).toBe(0);

    const drafted = await runCli(
      [
        "spec",
        "draft",
        "audit-log",
        "--file",
        SECOND_ELEMENT_FILE,
        "--base-version",
        "new",
      ],
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
      spec: {
        currentRevision: {
          elements: Array<{ version: { payload: { statement: string } } }>;
        };
      };
    };
    expect(
      body.spec.currentRevision.elements.map(
        ({ version }) => version.payload.statement,
      ),
    ).toEqual(["Audit events are durable.", "Audit events are queryable."]);
  });
});
