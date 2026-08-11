import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";

import { createSpecEventsPublisher } from "./events";
import { createImportService } from "./import-service";
import {
  createSpecWriteRouteHandlers,
  type SpecMutationServices,
  type SpecWriteRouteDeps,
} from "./route-handlers";

const PROJECT_PATH = "/repos/spec-import-route";

const auth: AgentAuth = {
  async requireToken(request) {
    const result = await this.validateOptionalToken(request);
    return result.kind === "valid"
      ? null
      : Response.json({ error: "Invalid token" }, { status: 401 });
  },
  async validateOptionalToken(request) {
    const value = request.headers.get("authorization");
    if (value === null) return { kind: "absent" };
    return value === "Bearer valid" ? { kind: "valid" } : { kind: "invalid" };
  },
};

const AGENT_HEADERS = {
  authorization: "Bearer valid",
  "x-cc-conversation-id": "conversation-import-agent",
} as const;

function bundleBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: "imported-through-the-route",
    name: "Imported Through The Route",
    source: { label: "kiro:.kiro/specs/route-feature" },
    sections: [
      { role: "intent_problem", title: "Problem", body: "Stated externally." },
    ],
    requirements: [
      {
        ref: "transport",
        statement: "An agent imports a spec through the project action.",
        priority: "must",
        risk: "high",
        criteria: [
          {
            text: "The import action is reachable from agent transport.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
    ],
    decisions: [],
    questions: [],
    assumptions: [],
    ...overrides,
  };
}

function importRequest(body: unknown): Request {
  return new Request(`http://cc.test/api/specs/demo/actions/import`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AGENT_HEADERS },
    body: JSON.stringify(body),
  });
}

const importRouteContext = {
  params: Promise.resolve({ name: "demo", action: "import" }),
};

let fixture: PersistenceFixture;
let handlers: ReturnType<typeof createSpecWriteRouteHandlers>;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const events = createSpecEventsRepo(fixture.db);
  // Only the import slot is real: this exercises the whole import path end to
  // end through the transport, and the other mutation services are unreachable
  // from the `import` action.
  const services = {
    import: createImportService({
      specs: fixture.specs,
      review: createSpecReviewRepo(fixture.db),
      links: createSpecLinksRepo(fixture.db),
      events: createSpecEventsPublisher({
        appendInTransaction: events.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
    }),
  } as unknown as SpecMutationServices;
  const deps: SpecWriteRouteDeps = {
    auth,
    resolveProjectPath: async (name) => (name === "demo" ? PROJECT_PATH : null),
    resolveSpec: async () => null,
    getServices: async () => services,
  };
  handlers = createSpecWriteRouteHandlers(deps);
});

afterEach(() => fixture.close());

describe("the project-scoped import action is agent-reachable (R3.1)", () => {
  it("lets an agent actor complete an import without human_act_required", async () => {
    const response = await handlers.projectActionPOST(
      importRequest(bundleBody()),
      importRouteContext,
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      spec: { slug: "imported-through-the-route", projectPath: PROJECT_PATH },
      revision: { state: "approved", authoringStage: "design" },
      counts: { requirements: 1, criteria: 1 },
    });

    const spec = await fixture.specs.resolve(
      PROJECT_PATH,
      "imported-through-the-route",
    );
    expect(spec).not.toBeNull();
    const revisions = await fixture.specs.listRevisions(spec?.id ?? "");
    expect(revisions.map(({ state }) => state)).toEqual(["approved"]);
  });

  it("returns the typed slug_taken refusal when the slug is already used", async () => {
    await handlers.projectActionPOST(
      importRequest(bundleBody()),
      importRouteContext,
    );

    const response = await handlers.projectActionPOST(
      importRequest(bundleBody({ name: "Second Attempt" })),
      importRouteContext,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "slug_taken",
    });
  });

  /**
   * The dry-run flag rides on the bundle because this action's transport parses
   * the whole request body with the bundle schema. That is what makes a
   * rehearsal reachable here with no transport change of its own — and it is
   * only true while the flag stays in that schema, which is what this asserts.
   */
  it("rehearses an import through the same action when the bundle asks for a dry run (R6.1)", async () => {
    const response = await handlers.projectActionPOST(
      importRequest(bundleBody({ dryRun: true })),
      importRouteContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      preview: {
        blocking: 0,
        counts: { requirements: 1, criteria: 1 },
        handles: {
          requirements: [
            {
              handle: "R1",
              summary: "An agent imports a spec through the project action.",
            },
          ],
          criteria: [
            {
              handle: "R1.1",
              summary: "The import action is reachable from agent transport.",
            },
          ],
        },
      },
    });
    expect(
      await fixture.specs.resolve(PROJECT_PATH, "imported-through-the-route"),
    ).toBeNull();
  });

  it("rejects a malformed bundle at the transport without creating a spec", async () => {
    const response = await handlers.projectActionPOST(
      importRequest(bundleBody({ requirements: "not-an-array" })),
      importRouteContext,
    );

    expect(response.status).toBe(400);
    expect(
      await fixture.specs.resolve(PROJECT_PATH, "imported-through-the-route"),
    ).toBeNull();
  });
});
