import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SSEEvent } from "@/lib/api/sse-events";
import { TicketRelationshipStoreError } from "@/lib/state-store/ticket-relationships-store";
import type {
  AddTicketRelationshipRepoInput,
  TicketRelationshipMutationResult,
} from "@/lib/state-store/tickets-repo";
import {
  createTicketRelationshipService,
  type TicketRelationshipService,
  type TicketRelationshipServiceDeps,
  type TicketRelationshipServiceRepo,
} from "./relationship-service";
import {
  RELATIONSHIP_CYCLE_RATIONALE,
  RELATIONSHIP_DUPLICATE_RATIONALE,
  RELATIONSHIP_SCOPE_RATIONALE,
  RELATIONSHIP_SELF_LINK_RATIONALE,
  ticketChangedEventSchema,
  type TicketDetail,
  type TicketListItem,
  type TicketRelationshipRole,
  type TicketRelationshipView,
} from "./schemas";

const ALPHA_NAME = "alpha";
const ALPHA_PATH = "/repos/alpha";
const BETA_NAME = "beta";
const BETA_PATH = "/repos/beta";

function ticket(
  projectName: string,
  number: number,
  id: string,
  overrides: Partial<TicketDetail> = {},
): TicketDetail {
  return {
    id,
    projectPath: `/repos/${projectName}`,
    projectName,
    number,
    title: `${projectName} ticket ${number}`,
    description: "",
    workType: "feature",
    status: "not_started",
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    attachments: [],
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
    ...overrides,
  };
}

function listItem(detail: TicketDetail): TicketListItem {
  return {
    id: detail.id,
    projectPath: detail.projectPath,
    projectName: detail.projectName,
    number: detail.number,
    title: detail.title,
    workType: detail.workType,
    status: detail.status,
    attachmentCount: detail.attachments.length,
    activeSessionName: null,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

function relationshipView(
  other: TicketDetail,
  role: TicketRelationshipRole = "related",
  id = "relationship-1",
): TicketRelationshipView {
  return {
    id,
    role,
    otherTicket: {
      id: other.id,
      projectName: other.projectName,
      number: other.number,
      title: other.title,
      status: other.status,
    },
    description: "rationale",
    createdAt: "2026-08-31T10:01:00.000Z",
    updatedAt: "2026-08-31T10:01:00.000Z",
  };
}

interface Harness {
  service: TicketRelationshipService;
  events: SSEEvent[];
  gatedPaths: string[][];
  lockedKeys: string[];
  addInputs: AddTicketRelationshipRepoInput[];
  repo: TicketRelationshipServiceRepo;
}

interface HarnessOverrides extends Omit<
  Partial<TicketRelationshipServiceDeps>,
  "repo"
> {
  repo?: Partial<TicketRelationshipServiceRepo>;
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const { repo: repoOverrides, ...dependencyOverrides } = overrides;
  const anchor = ticket(ALPHA_NAME, 1, "ticket-z");
  const target = ticket(BETA_NAME, 2, "ticket-a");
  const localTarget = ticket(ALPHA_NAME, 2, "ticket-a");
  const tickets = new Map([
    [`${ALPHA_PATH}#1`, anchor],
    [`${ALPHA_PATH}#2`, localTarget],
    [`${BETA_PATH}#2`, target],
  ]);
  const events: SSEEvent[] = [];
  const gatedPaths: string[][] = [];
  const lockedKeys: string[] = [];
  const addInputs: AddTicketRelationshipRepoInput[] = [];
  const defaultRelationship = relationshipView(target);
  const repo: TicketRelationshipServiceRepo = {
    find: async (projectPath, number) =>
      tickets.get(`${projectPath}#${number}`) ?? null,
    findListItem: async (projectPath, number) => {
      const detail = tickets.get(`${projectPath}#${number}`);
      return detail === undefined ? null : listItem(detail);
    },
    listRelationships: async () => ({
      items: [defaultRelationship],
      total: 1,
      nextCursor: null,
    }),
    findRelationship: async () => defaultRelationship,
    addRelationship: async (input) => {
      addInputs.push(input);
      return {
        relationship: defaultRelationship,
        tickets: [anchor, target],
        replacedRelationshipId: null,
      };
    },
    updateRelationship: async () => ({
      relationship: defaultRelationship,
      tickets: [anchor, target],
      replacedRelationshipId: null,
    }),
    removeRelationship: async () => ({
      relationshipId: defaultRelationship.id,
      tickets: [anchor, target],
    }),
    ...repoOverrides,
  };
  const deps: TicketRelationshipServiceDeps = {
    repo,
    resolveProjectPath: async (projectName) =>
      projectName === ALPHA_NAME
        ? ALPHA_PATH
        : projectName === BETA_NAME
          ? BETA_PATH
          : null,
    runMultiProjectTicketOperation: async (projectPaths, operation) => {
      gatedPaths.push([...projectPaths]);
      return operation({ projectDeletionPrecededOperation: false });
    },
    runTicketOperation: async (key, operation) => {
      lockedKeys.push(key);
      return operation();
    },
    publish: (event) => {
      events.push(event);
      return { delivered: true };
    },
    now: () => "2026-08-31T10:02:00.000Z",
    generateId: () => "relationship-new",
    ...dependencyOverrides,
  };
  return {
    service: createTicketRelationshipService(deps),
    events,
    gatedPaths,
    lockedKeys,
    addInputs,
    repo,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TicketRelationshipService", () => {
  it.each([
    ["related", BETA_NAME, BETA_PATH, "ticket-a", "ticket-z"],
    ["depends_on", BETA_NAME, BETA_PATH, "ticket-z", "ticket-a"],
    ["blocks", BETA_NAME, BETA_PATH, "ticket-a", "ticket-z"],
    ["parent", ALPHA_NAME, ALPHA_PATH, "ticket-a", "ticket-z"],
    ["child", ALPHA_NAME, ALPHA_PATH, "ticket-z", "ticket-a"],
  ] as const)(
    "normalizes the URL-relative %s role once before persistence",
    async (
      role,
      targetProjectName,
      targetProjectPath,
      sourceTicketId,
      targetTicketId,
    ) => {
      const harness = makeHarness();

      const result = await harness.service.add({
        projectName: ALPHA_NAME,
        number: 1,
        target: { projectName: targetProjectName, number: 2 },
        role,
      });

      expect(result.ok).toBe(true);
      expect(harness.addInputs).toEqual([
        {
          id: "relationship-new",
          anchorTicketId: "ticket-z",
          relationType:
            role === "related"
              ? "related"
              : role === "depends_on" || role === "blocks"
                ? "depends_on"
                : "parent_child",
          sourceTicketId,
          targetTicketId,
          description: "",
          createdAt: "2026-08-31T10:02:00.000Z",
        },
      ]);
      expect(harness.gatedPaths).toEqual([[ALPHA_PATH, targetProjectPath]]);
      expect(harness.lockedKeys).toEqual([
        `${ALPHA_PATH}::1`,
        `${targetProjectPath}::2`,
      ]);
    },
  );

  it("re-resolves projects and tickets after acquiring the multi-project gate", async () => {
    let insideGate = false;
    const anchorBefore = ticket(ALPHA_NAME, 1, "anchor-before");
    const targetBefore = ticket(BETA_NAME, 2, "target-before");
    const anchorAfter = ticket(ALPHA_NAME, 1, "anchor-after");
    const targetAfter = ticket(BETA_NAME, 2, "target-after");
    const harness = makeHarness({
      repo: {
        find: async (projectPath, number) => {
          if (projectPath === ALPHA_PATH && number === 1) {
            return insideGate ? anchorAfter : anchorBefore;
          }
          if (projectPath === BETA_PATH && number === 2) {
            return insideGate ? targetAfter : targetBefore;
          }
          return null;
        },
      },
      runMultiProjectTicketOperation: async (_paths, operation) => {
        insideGate = true;
        return operation({ projectDeletionPrecededOperation: true });
      },
    });

    await harness.service.add({
      projectName: ALPHA_NAME,
      number: 1,
      target: { projectName: BETA_NAME, number: 2 },
      role: "depends_on",
    });

    expect(harness.addInputs[0]).toMatchObject({
      anchorTicketId: "anchor-after",
      sourceTicketId: "anchor-after",
      targetTicketId: "target-after",
    });
  });

  it("acquires endpoint locks in deterministic order across reversed inputs", async () => {
    const harness = makeHarness();

    const result = await harness.service.add({
      projectName: BETA_NAME,
      number: 2,
      target: { projectName: ALPHA_NAME, number: 1 },
      role: "related",
    });

    expect(result.ok).toBe(true);
    expect(harness.lockedKeys).toEqual([`${ALPHA_PATH}::1`, `${BETA_PATH}::2`]);
    expect(harness.addInputs[0]).toMatchObject({
      anchorTicketId: "ticket-a",
      sourceTicketId: "ticket-a",
      targetTicketId: "ticket-z",
    });
  });

  it("returns typed self-link and project-scope refusals before persistence", async () => {
    const sameProjectTarget = ticket(ALPHA_NAME, 2, "ticket-a");
    const addRelationship = vi.fn();
    const harness = makeHarness({
      repo: {
        find: async (projectPath, number) => {
          if (projectPath === ALPHA_PATH && number === 1) {
            return ticket(ALPHA_NAME, 1, "ticket-z");
          }
          if (projectPath === ALPHA_PATH && number === 2) {
            return sameProjectTarget;
          }
          if (projectPath === BETA_PATH && number === 2) {
            return ticket(BETA_NAME, 2, "ticket-a");
          }
          return null;
        },
        addRelationship,
      },
    });

    const self = await harness.service.add({
      projectName: ALPHA_NAME,
      number: 1,
      target: { projectName: ALPHA_NAME, number: 1 },
      role: "related",
    });
    const scope = await harness.service.add({
      projectName: ALPHA_NAME,
      number: 1,
      target: { projectName: BETA_NAME, number: 2 },
      role: "parent",
    });

    expect(self).toEqual({
      ok: false,
      error: {
        code: "relationship_self_link",
        details: {
          source: { projectName: ALPHA_NAME, number: 1 },
          target: { projectName: ALPHA_NAME, number: 1 },
        },
        rationale: RELATIONSHIP_SELF_LINK_RATIONALE,
      },
    });
    expect(scope).toEqual({
      ok: false,
      error: {
        code: "relationship_scope",
        details: {
          source: { projectName: ALPHA_NAME, number: 1 },
          target: { projectName: BETA_NAME, number: 2 },
        },
        rationale: RELATIONSHIP_SCOPE_RATIONALE,
      },
    });
    expect(addRelationship).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: { kind: "ticket_not_found", ticketId: "ticket-a" } as const,
      expected: {
        code: "ticket_not_found",
        identifier: `${BETA_NAME}#2`,
      },
    },
    {
      failure: {
        kind: "duplicate",
        relationshipId: "relationship-existing",
      } as const,
      expected: {
        code: "relationship_conflict",
        details: {
          reason: "duplicate",
          relationshipId: "relationship-existing",
        },
        rationale: RELATIONSHIP_DUPLICATE_RATIONALE,
      },
    },
    {
      failure: {
        kind: "cycle",
        relationType: "depends_on",
        sourceTicketId: "ticket-z",
        targetTicketId: "ticket-a",
      } as const,
      expected: {
        code: "relationship_cycle",
        details: {
          relationType: "depends_on",
          source: { projectName: ALPHA_NAME, number: 1 },
          target: { projectName: BETA_NAME, number: 2 },
        },
        rationale: RELATIONSHIP_CYCLE_RATIONALE,
      },
    },
  ])(
    "maps $failure.kind store refusals to TicketError",
    async ({ failure, expected }) => {
      const harness = makeHarness({
        repo: {
          addRelationship: async () => {
            throw new TicketRelationshipStoreError(failure);
          },
        },
      });

      const result = await harness.service.add({
        projectName: ALPHA_NAME,
        number: 1,
        target: { projectName: BETA_NAME, number: 2 },
        role: "depends_on",
      });

      expect(result).toEqual({ ok: false, error: expected });
    },
  );

  it("publishes a relationship change for every authoritative reparent result", async () => {
    const child = ticket(ALPHA_NAME, 1, "child", {
      updatedAt: "2026-08-31T10:03:00.000Z",
    });
    const parent = ticket(ALPHA_NAME, 2, "parent-new", {
      updatedAt: "2026-08-31T10:03:00.000Z",
    });
    const oldParent = ticket(ALPHA_NAME, 3, "parent-old", {
      updatedAt: "2026-08-31T10:03:00.000Z",
    });
    const view = relationshipView(parent, "parent", "relationship-new");
    const authoritative: TicketRelationshipMutationResult = {
      relationship: view,
      tickets: [child, parent, oldParent],
      replacedRelationshipId: "relationship-old",
    };
    const byNumber = new Map(
      [child, parent, oldParent].map((detail) => [detail.number, detail]),
    );
    const harness = makeHarness({
      resolveProjectPath: async (name) =>
        name === ALPHA_NAME ? ALPHA_PATH : null,
      repo: {
        find: async (_path, number) => byNumber.get(number) ?? null,
        findListItem: async (_path, number) => {
          const detail = byNumber.get(number);
          return detail === undefined ? null : listItem(detail);
        },
        addRelationship: async () => authoritative,
      },
    });

    const result = await harness.service.add({
      projectName: ALPHA_NAME,
      number: 1,
      target: { projectName: ALPHA_NAME, number: 2 },
      role: "parent",
      description: "why",
    });

    expect(result).toEqual({
      ok: true,
      value: { relationship: view, tickets: authoritative.tickets },
    });
    expect(
      harness.events.map((event) => ticketChangedEventSchema.parse(event)),
    ).toEqual(
      [child, parent, oldParent].map((detail) => ({
        type: "ticket-changed",
        change: "relationships",
        projectName: ALPHA_NAME,
        ticketNumber: detail.number,
        listItem: listItem(detail),
        attachmentIndexChanged: false,
      })),
    );
  });

  it("updates and removes by relative relationship identity and fans out events", async () => {
    const anchor = ticket(ALPHA_NAME, 1, "ticket-z");
    const target = ticket(BETA_NAME, 2, "ticket-a");
    const view = relationshipView(target, "depends_on");
    const findRelationship = vi.fn(async () => view);
    const harness = makeHarness({
      repo: { findRelationship },
    });

    const updated = await harness.service.update({
      projectName: ALPHA_NAME,
      number: 1,
      relationshipId: view.id,
      description: "",
    });
    const removed = await harness.service.remove({
      projectName: ALPHA_NAME,
      number: 1,
      relationshipId: view.id,
    });

    expect(updated.ok).toBe(true);
    expect(removed.ok).toBe(true);
    expect(findRelationship).toHaveBeenCalledTimes(4);
    expect(harness.gatedPaths).toEqual([
      [ALPHA_PATH, BETA_PATH],
      [ALPHA_PATH, BETA_PATH],
    ]);
    expect(harness.events).toHaveLength(4);
    expect(
      harness.events.map(
        (event) => ticketChangedEventSchema.parse(event).change,
      ),
    ).toEqual([
      "relationships",
      "relationships",
      "relationships",
      "relationships",
    ]);
    expect(anchor.sessions).toEqual([]);
  });

  it("returns relationship_not_found when an edge disappears while waiting", async () => {
    const target = ticket(BETA_NAME, 2, "ticket-a");
    let lookupCount = 0;
    const harness = makeHarness({
      repo: {
        findRelationship: async () => {
          lookupCount += 1;
          return lookupCount === 1 ? relationshipView(target) : null;
        },
      },
    });

    const result = await harness.service.update({
      projectName: ALPHA_NAME,
      number: 1,
      relationshipId: "relationship-1",
      description: "changed",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "relationship_not_found",
        details: {
          identifier: `${ALPHA_NAME}#1`,
          relationshipId: "relationship-1",
        },
      },
    });
  });

  it("validates page limits and cursors before repository reads", async () => {
    const listRelationships = vi.fn();
    const harness = makeHarness({ repo: { listRelationships } });

    const badLimit = await harness.service.list({
      projectName: ALPHA_NAME,
      number: 1,
      limit: 101,
    });
    const badCursor = await harness.service.list({
      projectName: ALPHA_NAME,
      number: 1,
      cursor: "not-a-cursor",
    });

    expect(badLimit).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(badCursor).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(listRelationships).not.toHaveBeenCalled();
  });
});
