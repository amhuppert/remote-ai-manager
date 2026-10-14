import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import {} from "@/lib/config/loader";
import {} from "@/lib/config/schemas";
import type { PublishFn } from "@/lib/events/publication";
import { createMemoryRepo } from "@/lib/state-store/memory-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createMemoryFreshnessEngine } from "./freshness";
import {
  createMemoryIndexComposer,
  type MemoryIndexBlock,
  type MemoryIndexComposer,
  type MemoryIndexDeltaBasis,
  type MemoryIndexSubject,
} from "./index-composer";
import { type MemoryPolicySubject } from "./delivery-policy";
import {
  createMemoryIndexContextProvider,
  type MemoryIndexContextRequest,
  type PreparedMemoryIndexDelivery,
} from "./index-live-context";
import type {
  MemoryActor,
  MemoryArtifactRef,
  MemoryIndexBudget,
  MemoryReadPolicy,
} from "./schemas";
import { createMemoryService, type MemoryService } from "./service";
import type { MemoryIndexDeliveryRead } from "./telemetry";
import { openMemoryContributionGate } from "./testing/contribution-gate";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const SESSION_NAME = "memory-session";
const SESSION_CREATED_AT = "2026-09-01T09:00:00.000Z";
const BUDGET: MemoryIndexBudget = { bytes: 4096, hooks: 20 };
const NOW = "2026-09-01T10:00:00.000Z";

const SESSION_REQUEST: MemoryIndexContextRequest = {
  projectPath: PROJECT_PATH,
  conversationId: "conv-1",
  conversation: { kind: "session", sessionName: SESSION_NAME },
  role: null,
  workflowExecutionId: null,
  workflowContextId: null,
  runtimeCreatedWithoutResume: false,
  backendReportedCompactionLastTurn: false,
};
const PROJECT_REQUEST: MemoryIndexContextRequest = {
  projectPath: PROJECT_PATH,
  conversationId: "conv-project",
  conversation: { kind: "project" },
  role: null,
  workflowExecutionId: null,
  workflowContextId: null,
  runtimeCreatedWithoutResume: false,
  backendReportedCompactionLastTurn: false,
};

/** The shipped cascade in miniature: validators off, everyone else ambient. */
const SHIPPED_READ_POLICY = async (
  subject: MemoryPolicySubject,
): Promise<MemoryReadPolicy> =>
  subject.role === "validator" ? "off" : "ambient";

const RENDERED: MemoryIndexBlock = {
  kind: "full",
  text: "<memory-index>\n</memory-index>",
  bytes: 30,
  budget: BUDGET,
  entries: [],
  omitted: 0,
  total: 0,
  withheld: { reviewDue: 0, expired: 0, proposed: 0 },
  since: null,
};

const RENDERED_DELTA: MemoryIndexBlock = {
  ...RENDERED,
  kind: "delta",
  text: "<memory-index-delta>quiet</memory-index-delta>",
  bytes: 47,
  since: "2026-09-01T09:45:00.000Z",
};

const DELIVERY_STATE: MemoryIndexDeliveryRead = {
  state: {
    conversationId: "conv-1",
    lastFullAt: "2026-09-01T09:30:00.000Z",
    lastDeliveryAt: "2026-09-01T09:45:00.000Z",
    updatedAt: "2026-09-01T09:45:01.000Z",
  },
  watermarks: [],
};

function prepared(block: MemoryIndexBlock | null): PreparedMemoryIndexDelivery {
  return {
    mode: block?.kind ?? "full",
    composedAt: NOW,
    entries: block?.entries ?? [],
    block: block?.text ?? null,
    rendered: block,
  };
}

/** An injected composer that records what the provider asked it to compose. */
function recordingComposer(events: string[] = []): {
  composer: MemoryIndexComposer;
  calls: Array<{ subject: MemoryIndexSubject; budget: MemoryIndexBudget }>;
  deltaCalls: Array<{
    subject: MemoryIndexSubject;
    budget: MemoryIndexBudget;
    basis: MemoryIndexDeltaBasis;
  }>;
} {
  const calls: Array<{
    subject: MemoryIndexSubject;
    budget: MemoryIndexBudget;
  }> = [];
  const deltaCalls: Array<{
    subject: MemoryIndexSubject;
    budget: MemoryIndexBudget;
    basis: MemoryIndexDeltaBasis;
  }> = [];
  return {
    calls,
    deltaCalls,
    composer: {
      async compose(subject, budget) {
        events.push("compose:full");
        calls.push({ subject, budget });
        return RENDERED;
      },
      async composeDelta(subject, budget, basis) {
        events.push("compose:delta");
        deltaCalls.push({ subject, budget, basis });
        return RENDERED_DELTA;
      },
    },
  };
}

function createProvider(
  composer: MemoryIndexComposer,
  overrides: {
    sessionCreatedAt?: string | null;
    linkedTicketId?: string | null;
    budget?: MemoryIndexBudget;
    readPolicy?: (subject: MemoryPolicySubject) => Promise<MemoryReadPolicy>;
    deliveryRead?: MemoryIndexDeliveryRead;
    now?: string;
    events?: string[];
  } = {},
) {
  const lookups: string[] = [];
  const resets: string[] = [];
  const provider = createMemoryIndexContextProvider({
    composer,
    resolveReadPolicy: overrides.readPolicy ?? SHIPPED_READ_POLICY,
    async findSessionCreatedAt(projectPath, sessionName) {
      lookups.push(`session:${projectPath}:${sessionName}`);
      return overrides.sessionCreatedAt === undefined
        ? SESSION_CREATED_AT
        : overrides.sessionCreatedAt;
    },
    async findLinkedTicketId(projectPath, sessionName) {
      lookups.push(`ticket:${projectPath}:${sessionName}`);
      return overrides.linkedTicketId === undefined
        ? "ticket-74"
        : overrides.linkedTicketId;
    },
    async readBudget() {
      return overrides.budget ?? BUDGET;
    },
    async readIndexDelivery(conversationId) {
      lookups.push(`delivery:${conversationId}`);
      return overrides.deliveryRead ?? { state: null, watermarks: [] };
    },
    async resetIndexDelivery(conversationId) {
      overrides.events?.push("reset");
      resets.push(conversationId);
    },
    now() {
      return overrides.now ?? NOW;
    },
  });
  return { provider, lookups, resets };
}

describe("delivery preparation", () => {
  it("prepares the full block at one composition instant when no delivery state exists", async () => {
    const { composer, calls, deltaCalls } = recordingComposer();
    const { provider, lookups, resets } = createProvider(composer);

    const delivery = await provider.getForConversation(SESSION_REQUEST);

    expect(delivery).toEqual(prepared(RENDERED));
    expect(calls).toHaveLength(1);
    expect(deltaCalls).toEqual([]);
    expect(lookups).toContain("delivery:conv-1");
    expect(resets).toEqual([]);
  });

  it("prepares a delta against the delivery state and index watermarks", async () => {
    const { composer, calls, deltaCalls } = recordingComposer();
    const { provider, resets } = createProvider(composer, {
      deliveryRead: DELIVERY_STATE,
    });

    const delivery = await provider.getForConversation(SESSION_REQUEST);

    expect(delivery).toEqual(prepared(RENDERED_DELTA));
    expect(calls).toEqual([]);
    expect(deltaCalls).toEqual([
      expect.objectContaining({ basis: DELIVERY_STATE, budget: BUDGET }),
    ]);
    expect(resets).toEqual([]);
  });

  it.each([
    {
      case: "a runtime without a resume handle",
      signals: { runtimeCreatedWithoutResume: true },
    },
    {
      case: "a backend-reported compaction",
      signals: { backendReportedCompactionLastTurn: true },
    },
  ] as const)(
    "resets before composing full after $case",
    async ({ signals }) => {
      const events: string[] = [];
      const { composer, calls, deltaCalls } = recordingComposer(events);
      const { provider, resets } = createProvider(composer, {
        deliveryRead: DELIVERY_STATE,
        events,
      });

      const delivery = await provider.getForConversation({
        ...SESSION_REQUEST,
        ...signals,
      });

      expect(delivery).toEqual(prepared(RENDERED));
      expect(events).toEqual(["reset", "compose:full"]);
      expect(resets).toEqual(["conv-1"]);
      expect(calls).toHaveLength(1);
      expect(deltaCalls).toEqual([]);
    },
  );

  it("prepares an empty full delivery even when the composer renders no block", async () => {
    const composer: MemoryIndexComposer = {
      async compose() {
        return null;
      },
      async composeDelta() {
        return RENDERED_DELTA;
      },
    };
    const { provider } = createProvider(composer);

    await expect(provider.getForConversation(PROJECT_REQUEST)).resolves.toEqual(
      prepared(null),
    );
  });

  it.each([
    { case: "full", deliveryRead: undefined, expectedMode: "full" },
    { case: "delta", deliveryRead: DELIVERY_STATE, expectedMode: "delta" },
  ] as const)(
    "keeps linked-only subject selection in $case mode",
    async ({ deliveryRead, expectedMode }) => {
      const { composer, calls, deltaCalls } = recordingComposer();
      const { provider } = createProvider(composer, {
        deliveryRead,
        readPolicy: async () => "linked-only",
      });

      const delivery = await provider.getForConversation(SESSION_REQUEST);

      expect(delivery?.mode).toBe(expectedMode);
      expect((calls[0] ?? deltaCalls[0])?.subject.delivery).toBe("linked-only");
    },
  );
});

describe("subject resolution", () => {
  it("composes a session conversation at its incarnation's visibility with its linked ticket as the active artifact", async () => {
    const { composer, calls } = recordingComposer();
    const { provider } = createProvider(composer);

    const block = await provider.getForConversation(SESSION_REQUEST);

    expect(block).toEqual(prepared(RENDERED));
    expect(calls).toEqual([
      {
        subject: {
          conversation: { kind: "session", sessionName: SESSION_NAME },
          visibility: {
            projectPath: PROJECT_PATH,
            session: {
              sessionName: SESSION_NAME,
              sessionCreatedAt: SESSION_CREATED_AT,
            },
          },
          activeArtifacts: [{ kind: "ticket", ticketId: "ticket-74" }],
          delivery: "ambient",
        },
        budget: BUDGET,
      },
    ]);
  });

  it("composes a project conversation at project visibility without any session or ticket lookup", async () => {
    const { composer, calls } = recordingComposer();
    const { provider, lookups } = createProvider(composer);

    await provider.getForConversation(PROJECT_REQUEST);

    expect(lookups).toEqual(["delivery:conv-project"]);
    expect(calls[0]?.subject).toEqual({
      conversation: { kind: "project" },
      visibility: { projectPath: PROJECT_PATH, session: null },
      activeArtifacts: [],
      delivery: "ambient",
    });
  });

  it("re-reads the budget from settings on every call", async () => {
    const { composer, calls } = recordingComposer();
    let budget: MemoryIndexBudget = { bytes: 2048, hooks: 10 };
    const provider = createMemoryIndexContextProvider({
      composer,
      resolveReadPolicy: SHIPPED_READ_POLICY,
      async findSessionCreatedAt() {
        return SESSION_CREATED_AT;
      },
      async findLinkedTicketId() {
        return null;
      },
      async readBudget() {
        return budget;
      },
      async readIndexDelivery() {
        return { state: null, watermarks: [] };
      },
      async resetIndexDelivery() {},
      now: () => NOW,
    });

    await provider.getForConversation(PROJECT_REQUEST);
    budget = { bytes: 8192, hooks: 40 };
    await provider.getForConversation(PROJECT_REQUEST);

    expect(calls.map((call) => call.budget)).toEqual([
      { bytes: 2048, hooks: 10 },
      { bytes: 8192, hooks: 40 },
    ]);
  });
});

describe("read policy gate (R10)", () => {
  it("delivers nothing to a validator and never consults the store for it", async () => {
    const { composer, calls } = recordingComposer();
    const { provider, lookups } = createProvider(composer);

    const block = await provider.getForConversation({
      ...SESSION_REQUEST,
      role: "validator",
    });

    expect(block).toBeNull();
    expect(calls).toEqual([]);
    expect(lookups).toEqual([]);
  });
});

describe("live re-read (R5.1, R6)", () => {
  let db: Db;
  let service: MemoryService;
  let composer: MemoryIndexComposer;

  const publish: PublishFn = () => ({ delivered: true });
  const USER_IN_PROJECT: MemoryActor = {
    kind: "user",
    visibility: { projectPath: PROJECT_PATH, session: null },
  };

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    const repo = createMemoryRepo(db, createWriteQueue());
    createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
    let idSeq = 0;
    const sessions = {
      async isSessionIncarnationOver() {
        return false;
      },
    };
    service = createMemoryService({
      repo,
      publish,
      contributionGate: openMemoryContributionGate(),
      sessions,
      now: () => NOW,
      generateId: () => `id-${(idSeq += 1)}`,
    });
    composer = createMemoryIndexComposer({
      repo,
      freshness: createMemoryFreshnessEngine({
        repo,
        sessions,
        now: () => NOW,
      }),
      now: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("reflects a note created between two calls, and its archival, with the same provider instance", async () => {
    const { provider } = createProvider(composer, { linkedTicketId: null });

    expect(await provider.getForConversation(PROJECT_REQUEST)).toEqual(
      prepared(null),
    );

    const created = await service.create(
      {
        scope: "project",
        kind: "lesson",
        slug: "captured-mid-flight",
        hook: "A lesson captured after the first call",
      },
      USER_IN_PROJECT,
    );
    if (!created.ok) throw new Error(created.error.code);
    const second = await provider.getForConversation(PROJECT_REQUEST);
    expect(second?.block).toContain(
      "- captured-mid-flight [project, just now]",
    );

    const archived = await service.archive(
      "captured-mid-flight",
      { baseRevision: created.value.note.revision },
      USER_IN_PROJECT,
    );
    expect(archived.ok).toBe(true);
    expect(await provider.getForConversation(PROJECT_REQUEST)).toEqual(
      prepared(null),
    );
  });

  describe("linked-only is exact to the context under validation (R10.1)", () => {
    const EXECUTION = "exec-1";
    const laneRequest = (
      role: MemoryIndexContextRequest["role"],
      contextId: string,
    ): MemoryIndexContextRequest => ({
      ...SESSION_REQUEST,
      role,
      workflowExecutionId: EXECUTION,
      workflowContextId: contextId,
    });

    async function seedRun() {
      const about = async (
        slug: string,
        artifact: MemoryArtifactRef | null,
      ) => {
        const created = await service.create(
          { scope: "project", kind: "lesson", slug, hook: `Lesson ${slug}` },
          USER_IN_PROJECT,
        );
        if (!created.ok) throw new Error(created.error.code);
        if (artifact === null) return;
        const link = await service.link(
          slug,
          { kind: "about", artifact },
          USER_IN_PROJECT,
        );
        if (!link.ok) throw new Error(link.error.code);
      };
      await about("about-ctx-a", {
        kind: "workflow_context",
        executionId: EXECUTION,
        contextId: "ctx-a",
      });
      await about("about-ctx-b", {
        kind: "workflow_context",
        executionId: EXECUTION,
        contextId: "ctx-b",
      });
      await about("about-execution", {
        kind: "workflow_execution",
        executionId: EXECUTION,
      });
      await about("about-ticket", { kind: "ticket", ticketId: "ticket-74" });
      await about("unlinked", null);
    }

    it("delivers exactly the notes about-linked to the lane's own context, not its siblings', the run's, or the ticket's", async () => {
      await seedRun();
      const { provider } = createProvider(composer, {
        readPolicy: async () => "linked-only",
      });

      const forA = await provider.getForConversation(
        laneRequest("validator", "ctx-a"),
      );
      const forB = await provider.getForConversation(
        laneRequest("validator", "ctx-b"),
      );

      expect(forA?.entries.map((entry) => entry.slug)).toEqual(["about-ctx-a"]);
      expect(forB?.entries.map((entry) => entry.slug)).toEqual(["about-ctx-b"]);
      expect(forA?.block).toContain("delivery: linked-only");
      expect(forA?.block).not.toContain("about-execution");
      expect(forA?.block).not.toContain("about-ticket");
      expect(forA?.block).not.toContain("unlinked");
    });

    it("cues the lane's context in ambient delivery beside the run and the ticket, ahead of the unlinked library", async () => {
      await seedRun();
      const { provider } = createProvider(composer);

      const block = await provider.getForConversation(
        laneRequest("iteration", "ctx-a"),
      );

      const bySection = (section: string) =>
        block?.entries
          .filter((entry) => entry.section === section)
          .map((entry) => entry.slug)
          .sort();
      expect(bySection("about")).toEqual([
        "about-ctx-a",
        "about-execution",
        "about-ticket",
      ]);
      // A sibling context's link is no cue for this lane, but ambient still
      // delivers the whole library, so the sibling's note lands in auto.
      expect(bySection("auto")).toEqual(
        expect.arrayContaining(["about-ctx-b", "unlinked"]),
      );
    });
  });
});
