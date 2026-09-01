import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import {
  createTicketRelationshipRouteHandlers,
  type TicketRelationshipRouteDeps,
} from "./relationship-route-handlers";
import type {
  AddTicketRelationshipServiceInput,
  GetTicketRelationshipServiceInput,
  ListTicketRelationshipsServiceInput,
  RemoveTicketRelationshipServiceInput,
  TicketRelationshipService,
  UpdateTicketRelationshipServiceInput,
} from "./relationship-service";
import {
  RELATIONSHIP_CYCLE_RATIONALE,
  RELATIONSHIP_DUPLICATE_RATIONALE,
  RELATIONSHIP_SCOPE_RATIONALE,
  RELATIONSHIP_SELF_LINK_RATIONALE,
  ticketRelationshipDeleteResponseSchema,
  ticketRelationshipMutationResponseSchema,
  ticketRelationshipPageSchema,
  ticketRelationshipViewSchema,
  type TicketDetail,
  type TicketError,
  type TicketRelationshipView,
} from "./schemas";
import { encodeTicketKeysetCursor } from "./ticket-keyset-cursor";

const PROJECT_NAME = "alpha";
const BASE = `http://localhost/api/projects/${PROJECT_NAME}/tickets/7/relationships`;

function ticket(projectName = PROJECT_NAME, number = 7): TicketDetail {
  return {
    id: `ticket-${projectName}-${number}`,
    projectPath: `/repos/${projectName}`,
    projectName,
    number,
    title: `${projectName} ticket ${number}`,
    description: "",
    workType: "feature",
    status: "not_started",
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:01:00.000Z",
    attachments: [],
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  };
}

const otherTicket = ticket("beta", 3);
const relationship: TicketRelationshipView = {
  id: "relationship-1",
  role: "depends_on",
  otherTicket: {
    id: otherTicket.id,
    projectName: otherTicket.projectName,
    number: otherTicket.number,
    title: otherTicket.title,
    status: otherTicket.status,
  },
  description: "The API work depends on storage.",
  createdAt: "2026-08-31T10:00:30.000Z",
  updatedAt: "2026-08-31T10:01:00.000Z",
};

const page = { items: [relationship], total: 1, nextCursor: null };
const mutation = {
  relationship,
  tickets: [ticket(), otherTicket],
};
const removal = {
  relationshipId: relationship.id,
  tickets: [ticket(), otherTicket],
};

interface CapturedInputs {
  list: ListTicketRelationshipsServiceInput[];
  get: GetTicketRelationshipServiceInput[];
  add: AddTicketRelationshipServiceInput[];
  update: UpdateTicketRelationshipServiceInput[];
  remove: RemoveTicketRelationshipServiceInput[];
}

function makeHarness(
  options: {
    auth?: OptionalTokenValidation;
    service?: Partial<TicketRelationshipService>;
  } = {},
) {
  const captured: CapturedInputs = {
    list: [],
    get: [],
    add: [],
    update: [],
    remove: [],
  };
  const service: TicketRelationshipService = {
    async list(input) {
      captured.list.push(input);
      return { ok: true, value: page };
    },
    async get(input) {
      captured.get.push(input);
      return { ok: true, value: relationship };
    },
    async add(input) {
      captured.add.push(input);
      return { ok: true, value: mutation };
    },
    async update(input) {
      captured.update.push(input);
      return { ok: true, value: mutation };
    },
    async remove(input) {
      captured.remove.push(input);
      return { ok: true, value: removal };
    },
    ...options.service,
  };
  const deps: TicketRelationshipRouteDeps = {
    getService: () => service,
    async validateOptionalToken() {
      return options.auth ?? { kind: "absent" };
    },
  };
  return {
    handlers: createTicketRelationshipRouteHandlers(deps),
    captured,
  };
}

function context(overrides: Partial<Record<string, string>> = {}) {
  return {
    params: Promise.resolve({
      name: PROJECT_NAME,
      number: "7",
      relationshipId: relationship.id,
      ...overrides,
    }),
  };
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ticket relationship HTTP routes", () => {
  it("accepts browser and authenticated reads while refusing an invalid optional token", async () => {
    const browser = makeHarness({ auth: { kind: "absent" } });
    const agent = makeHarness({ auth: { kind: "valid" } });
    const rejected = makeHarness({ auth: { kind: "invalid" } });

    const [browserResponse, agentResponse, rejectedResponse] =
      await Promise.all([
        browser.handlers.indexGET(new Request(BASE), context()),
        agent.handlers.indexGET(new Request(BASE), context()),
        rejected.handlers.indexGET(new Request(BASE), context()),
      ]);

    expect(browserResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);
    expect(rejectedResponse.status).toBe(401);
    expect(await rejectedResponse.json()).toEqual({
      error: "Invalid Command Center API token",
    });
    expect(rejected.captured.list).toEqual([]);
  });

  it("strictly parses a role-filtered keyset page before serving its canonical schema", async () => {
    const cursor = encodeTicketKeysetCursor({
      timestamp: relationship.updatedAt,
      id: relationship.id,
    });
    const { handlers, captured } = makeHarness();
    const response = await handlers.indexGET(
      new Request(`${BASE}?role=depends_on&limit=37&cursor=${cursor}`),
      context(),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(ticketRelationshipPageSchema.parse(body)).toEqual(page);
    expect(captured.list).toEqual([
      {
        projectName: PROJECT_NAME,
        number: 7,
        role: "depends_on",
        limit: 37,
        cursor,
      },
    ]);
  });

  it.each([
    ["unknown query key", `${BASE}?offset=2`, "offset"],
    ["invalid role", `${BASE}?role=prerequisite`, "role"],
    ["limit below one", `${BASE}?limit=0`, "limit"],
    ["limit above one hundred", `${BASE}?limit=101`, "limit"],
    ["fractional limit", `${BASE}?limit=1.5`, "limit"],
    ["malformed cursor", `${BASE}?cursor=not-a-cursor`, "cursor"],
  ])("rejects %s without reaching the service", async (_label, url, path) => {
    const { handlers, captured } = makeHarness();
    const response = await handlers.indexGET(new Request(url), context());
    const body = (await response.json()) as {
      code: string;
      issues: Array<{ path: string }>;
    };

    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
    expect(body.issues.some((issue) => issue.path === path)).toBe(true);
    expect(captured.list).toEqual([]);
  });

  it("creates a relationship from a strict relative body and returns every authoritative ticket", async () => {
    const { handlers, captured } = makeHarness();
    const response = await handlers.addPOST(
      jsonRequest(BASE, "POST", {
        target: { projectName: "beta", number: 3 },
        role: "blocks",
      }),
      context(),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(ticketRelationshipMutationResponseSchema.parse(body)).toEqual(
      mutation,
    );
    expect(captured.add).toEqual([
      {
        projectName: PROJECT_NAME,
        number: 7,
        target: { projectName: "beta", number: 3 },
        role: "blocks",
        description: "",
      },
    ]);
  });

  it.each([
    ["non-object JSON", [], ""],
    [
      "unknown body key",
      {
        target: { projectName: "beta", number: 3 },
        role: "related",
        sourceTicketId: "caller-owned",
      },
      "sourceTicketId",
    ],
    [
      "unknown target key",
      {
        target: { projectName: "beta", number: 3, id: "caller-owned" },
        role: "related",
      },
      "target",
    ],
  ])("rejects a relationship add with %s", async (_label, body, issuePath) => {
    const { handlers, captured } = makeHarness();
    const response = await handlers.addPOST(
      jsonRequest(BASE, "POST", body),
      context(),
    );
    const payload = (await response.json()) as {
      code: string;
      issues: Array<{ path: string }>;
    };

    expect(response.status).toBe(400);
    expect(payload.code).toBe("validation_failed");
    if (issuePath !== "") {
      expect(
        payload.issues.some((issue) => issue.path.startsWith(issuePath)),
      ).toBe(true);
    }
    expect(captured.add).toEqual([]);
  });

  it("gets, clears, and removes by a strictly parsed relationship id", async () => {
    const { handlers, captured } = makeHarness();
    const getResponse = await handlers.resolveGET(
      new Request(`${BASE}/${relationship.id}`),
      context(),
    );
    const patchResponse = await handlers.editPATCH(
      jsonRequest(`${BASE}/${relationship.id}`, "PATCH", {
        description: "",
      }),
      context(),
    );
    const deleteResponse = await handlers.removeDELETE(
      new Request(`${BASE}/${relationship.id}`, { method: "DELETE" }),
      context(),
    );

    expect(
      ticketRelationshipViewSchema.parse(await getResponse.json()),
    ).toEqual(relationship);
    expect(
      ticketRelationshipMutationResponseSchema.parse(
        await patchResponse.json(),
      ),
    ).toEqual(mutation);
    expect(
      ticketRelationshipDeleteResponseSchema.parse(await deleteResponse.json()),
    ).toEqual(removal);
    expect(captured.get).toEqual([
      { projectName: PROJECT_NAME, number: 7, relationshipId: relationship.id },
    ]);
    expect(captured.update).toEqual([
      {
        projectName: PROJECT_NAME,
        number: 7,
        relationshipId: relationship.id,
        description: "",
      },
    ]);
    expect(captured.remove).toEqual([
      { projectName: PROJECT_NAME, number: 7, relationshipId: relationship.id },
    ]);
  });

  it("requires PATCH to contain only an explicit description", async () => {
    const { handlers, captured } = makeHarness();
    const missing = await handlers.editPATCH(
      jsonRequest(`${BASE}/${relationship.id}`, "PATCH", {}),
      context(),
    );
    const widened = await handlers.editPATCH(
      jsonRequest(`${BASE}/${relationship.id}`, "PATCH", {
        description: "updated",
        role: "related",
      }),
      context(),
    );

    expect(missing.status).toBe(400);
    expect(widened.status).toBe(400);
    expect(captured.update).toEqual([]);
  });

  it("rejects invalid ticket numbers and empty route ids before a service call", async () => {
    const { handlers, captured } = makeHarness();
    const invalidNumber = await handlers.resolveGET(
      new Request(`${BASE}/${relationship.id}`),
      context({ number: "7.5" }),
    );
    const emptyId = await handlers.removeDELETE(
      new Request(`${BASE}/empty`, { method: "DELETE" }),
      context({ relationshipId: "" }),
    );

    expect(invalidNumber.status).toBe(400);
    expect(emptyId.status).toBe(400);
    expect(captured.get).toEqual([]);
    expect(captured.remove).toEqual([]);
  });

  it.each([
    [
      "relationship_not_found",
      404,
      {
        code: "relationship_not_found" as const,
        details: {
          identifier: "alpha#7",
          relationshipId: relationship.id,
        },
      },
    ],
    [
      "relationship_self_link",
      400,
      {
        code: "relationship_self_link" as const,
        details: {
          source: { projectName: "alpha", number: 7 },
          target: { projectName: "alpha", number: 7 },
        },
        rationale: RELATIONSHIP_SELF_LINK_RATIONALE,
      },
    ],
    [
      "relationship_scope",
      400,
      {
        code: "relationship_scope" as const,
        details: {
          source: { projectName: "alpha", number: 7 },
          target: { projectName: "beta", number: 3 },
        },
        rationale: RELATIONSHIP_SCOPE_RATIONALE,
      },
    ],
    [
      "relationship_conflict",
      409,
      {
        code: "relationship_conflict" as const,
        details: {
          reason: "duplicate" as const,
          relationshipId: relationship.id,
        },
        rationale: RELATIONSHIP_DUPLICATE_RATIONALE,
      },
    ],
    [
      "relationship_cycle",
      409,
      {
        code: "relationship_cycle" as const,
        details: {
          relationType: "depends_on" as const,
          source: { projectName: "alpha", number: 7 },
          target: { projectName: "beta", number: 3 },
        },
        rationale: RELATIONSHIP_CYCLE_RATIONALE,
      },
    ],
  ])(
    "maps %s to its stable HTTP status and structured body",
    async (_code, status, error) => {
      const { handlers } = makeHarness({
        service: {
          async get() {
            return { ok: false, error: error as TicketError };
          },
        },
      });
      const response = await handlers.resolveGET(
        new Request(`${BASE}/${relationship.id}`),
        context(),
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(status);
      expect(body.code).toBe(error.code);
      expect(body.details).toEqual(error.details);
      if ("rationale" in error) {
        expect(body.rationale).toBe(error.rationale);
      }
    },
  );
});
