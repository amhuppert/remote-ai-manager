import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import {
  specLinkRowSchema,
  type SpecLinkObjectKind,
  type SpecLinkRow,
} from "@/lib/specs/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { _createTestDb } from "./state-db";
import { stableStringify } from "./serialization";
import { createSpecLinksRepo, type SpecLinksRepo } from "./spec-links-repo";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-links-maximal";
const OTHER_SPEC_ID = "spec-links-other";
const ELEMENT_ID = "requirement-links-maximal";

let db: Db;
let repo: SpecLinksRepo;

function insertSpec(id: string, slug: string): void {
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "/repos/links-contract",
    slug,
    `Links contract ${slug}`,
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T08:00:00.000Z",
    "2026-07-18T08:01:00.000Z",
  );
}

function seedLinkParents(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repos/links-contract",
  );
  insertSpec(SPEC_ID, "links-contract");
  insertSpec(OTHER_SPEC_ID, "links-contract-other");
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ELEMENT_ID,
    SPEC_ID,
    "requirement",
    5,
    null,
    "2026-07-18T08:02:00.000Z",
  );
}

function maximalLink(): SpecLinkRow {
  return specLinkRowSchema.parse({
    id: "link-maximal",
    spec_id: SPEC_ID,
    object_kind: "workflow_execution",
    object_ref_json: stableStringify({
      projectPath: "/repos/links-contract",
      sessionName: "native-sdd-links",
      workflowExecutionId: "workflow-execution-links-maximal",
    }),
    direction: "inbound",
    category: "graduated_from",
    snapshot_json: stableStringify({
      sourceType: "conversation",
      sourceId: "conversation-links-maximal",
      transcriptRevision: "sha256:transcript-links-maximal",
      capturedAt: "2026-07-18T12:00:00.000Z",
      content: {
        title: "Native SDD design discussion",
        messageIds: ["message-14", "message-18"],
      },
    }),
    element_ids_json: stableStringify([ELEMENT_ID, "criterion-links-maximal"]),
    actor_json: stableStringify({
      kind: "agent",
      conversationId: "conversation-links-maximal",
      backend: "codex",
    }),
    created_at: "2026-07-18T12:01:00.000Z",
  });
}

function linkFixture(
  id: string,
  specId: string,
  objectKind: SpecLinkObjectKind,
  objectRefJson: string,
): SpecLinkRow {
  return specLinkRowSchema.parse({
    ...maximalLink(),
    id,
    spec_id: specId,
    object_kind: objectKind,
    object_ref_json: objectRefJson,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedLinkParents();
  repo = createSpecLinksRepo(db);
});

afterEach(() => {
  db.close();
});

describe("spec-links-repo durability contract", () => {
  it("round-trips every persisted link field including the immutable source snapshot", async () => {
    await assertRoundTripDurability({
      label: "spec-link",
      schema: specLinkRowSchema,
      buildMaximalFixture: maximalLink,
      persist: (fixture) => {
        repo.insertLink(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findLinkById(fixture.id),
    });

    expect(JSON.parse(maximalLink().snapshot_json ?? "null")).toEqual({
      capturedAt: "2026-07-18T12:00:00.000Z",
      content: {
        messageIds: ["message-14", "message-18"],
        title: "Native SDD design discussion",
      },
      sourceId: "conversation-links-maximal",
      sourceType: "conversation",
      transcriptRevision: "sha256:transcript-links-maximal",
    });
  });

  it("queries links by spec without leaking another spec's links", () => {
    const first = maximalLink();
    const second = linkFixture(
      "link-same-spec",
      SPEC_ID,
      "ticket",
      stableStringify({ projectPath: "/repos/links-contract", number: 27 }),
    );
    const other = linkFixture(
      "link-other-spec",
      OTHER_SPEC_ID,
      "conversation",
      stableStringify({ conversationId: "conversation-other" }),
    );
    repo.insertLink(first);
    repo.insertLink(second);
    repo.insertLink(other);

    expect(repo.findBySpecId(SPEC_ID)).toEqual([first, second]);
    expect(repo.findBySpecId(OTHER_SPEC_ID)).toEqual([other]);
  });

  it("queries every matching spec link by linked object identity", () => {
    const objectRefJson = stableStringify({
      projectPath: "/repos/links-contract",
      sessionName: "native-sdd-links",
    });
    const first = linkFixture(
      "link-session-first",
      SPEC_ID,
      "session",
      objectRefJson,
    );
    const second = linkFixture(
      "link-session-second",
      OTHER_SPEC_ID,
      "session",
      objectRefJson,
    );
    repo.insertLink(first);
    repo.insertLink(second);
    repo.insertLink(
      linkFixture(
        "link-merge-job",
        SPEC_ID,
        "merge_job",
        stableStringify({ mergeJobId: "merge-job-7" }),
      ),
    );

    expect(repo.findByLinkedObject("session", objectRefJson)).toEqual([
      first,
      second,
    ]);
    expect(
      repo.findByLinkedObject("workflow_execution", objectRefJson),
    ).toEqual([]);
  });

  it("durably reserves one source entry identity and completes its snapshot", () => {
    const objectRefJson = stableStringify({
      projectName: "links-contract",
      sessionName: "session-entry",
      conversationId: "conversation-entry",
    });
    const reserved = specLinkRowSchema.parse({
      ...maximalLink(),
      id: "link-entry-reserved",
      object_kind: "conversation",
      object_ref_json: objectRefJson,
      category: "source",
      snapshot_json: null,
    });
    repo.insertLink(reserved);
    repo.updateLinkSnapshot(
      reserved.id,
      stableStringify({ messageIds: ["message-1"] }),
    );
    expect(repo.findLinkById(reserved.id)?.snapshot_json).toBe(
      stableStringify({ messageIds: ["message-1"] }),
    );

    expect(() =>
      repo.insertLink({
        ...reserved,
        id: "link-entry-duplicate",
        spec_id: OTHER_SPEC_ID,
      }),
    ).toThrow();
  });
});
