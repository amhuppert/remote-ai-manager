import { afterEach, describe, expect, it } from "vitest";

import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import type { Db } from "@/lib/state-store/schemas";
import { readSpecApprovalStatus } from "./approval-status";

describe("readSpecApprovalStatus", () => {
  let db: Db | undefined;
  afterEach(() => db?.close());

  it("observes a newly granted approval on the next authoritative status read", () => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/repo");
    db.prepare(
      `INSERT INTO specs (
         id, project_path, slug, name, gate_policy_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "spec-1",
      "/repo",
      "native-sdd",
      "Native SDD",
      '{"preset":"contract-bearing"}',
      "2026-07-18T10:00:00.000Z",
      "2026-07-18T10:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run("revision-1", "spec-1", 1, "proposed", "2026-07-18T10:00:00.000Z");
    const repo = createSpecReviewRepo(db);
    const input = {
      specId: "spec-1",
      revisionId: "revision-1",
      subjectKind: "revision" as const,
      elementId: null,
    };

    expect(readSpecApprovalStatus(repo, input)).toEqual({ status: "pending" });

    repo.saveApproval({
      id: "approval-1",
      spec_id: "spec-1",
      subject_kind: "revision",
      element_id: null,
      revision_id: "revision-1",
      approver: "Alex",
      granted_at: "2026-07-18T10:01:00.000Z",
      validity: "valid",
    });

    expect(readSpecApprovalStatus(repo, input)).toEqual({
      status: "granted",
      approvalId: "approval-1",
      grantedAt: "2026-07-18T10:01:00.000Z",
    });
  });
});
