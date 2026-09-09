/**
 * Retention and deletion ownership for checkpoint records.
 *
 * Checkpoint rows have no foreign key to a conversation — a conversation lives
 * in one of two tables depending on scope — so "deleting a conversation removes
 * its checkpoints" is a claim about the cleanup triggers, not about a cascade
 * the schema would give for free. These tests drive the real store setters that
 * every explicit deletion path funnels through, and assert the inverse for the
 * two operations that must NOT delete: archiving and compaction.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readTranscriptImage,
  saveTranscriptImage,
} from "@/lib/images/transcript-images";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT = "/projects/retention";
const OTHER_PROJECT = "/projects/bystander";
const SESSION = "csm-retention";
const SIBLING_SESSION = "csm-sibling";

let fx: PersistenceFixture;
let configDir: string;

beforeEach(async () => {
  fx = createPersistenceFixture();
  configDir = await mkdtemp(path.join(tmpdir(), "cc-checkpoint-retention-"));
});

afterEach(async () => {
  fx.close();
  await rm(configDir, { recursive: true, force: true });
});

function conversation(id: string): ConversationState {
  return makeConversationState({ id, agentBackend: "claude" });
}

interface SeedCheckpointInput {
  operationId: string;
  scope: "session" | "project";
  projectPath?: string;
  sessionName?: string | null;
  conversationId: string;
  ordinal?: number;
  phase?: string;
  withPayload?: boolean;
}

/**
 * Insert one operation (and optionally its frozen payload) with raw SQL. The
 * repository is not used here on purpose: these tests are about what the
 * DATABASE does to rows a delete elsewhere never mentions, so the rows must be
 * present regardless of any repository-level admission rule.
 */
function seedCheckpoint(input: SeedCheckpointInput): void {
  fx.db
    .prepare(
      `INSERT INTO conversation_checkpoint_operations (
         id, scope, project_path, session_name, conversation_id, ordinal, phase,
         captured_through_seq, source_hash, requested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.operationId,
      input.scope,
      input.projectPath ?? PROJECT,
      input.scope === "session" ? (input.sessionName ?? SESSION) : null,
      input.conversationId,
      input.ordinal ?? 1,
      input.phase ?? "ready",
      100,
      "sha256:retention",
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
    );
  if (input.withPayload !== false) {
    fx.db
      .prepare(
        `INSERT INTO conversation_checkpoints (
           id, schema_version, captured_through_seq, source_hash,
           generator_version, builder_version, normalizer_version,
           model_selection_json, sections_json, seed_text, seed_sha256,
           section_bytes_json, omissions_json, generation_pass_count, created_at
         ) VALUES (?, 1, 100, ?, 'gen-1', 'build-1', 'norm-1', ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        input.operationId,
        "sha256:retention",
        JSON.stringify({ kind: "alias", alias: "sonnet" }),
        JSON.stringify({ workingState: "kept", recentDialogue: "kept" }),
        "## Working state\nkeep going\n",
        "sha256:seed",
        JSON.stringify({ total: 42 }),
        JSON.stringify([]),
        "2026-09-01T00:00:00Z",
      );
  }
}

function operationIds(): string[] {
  return fx.db
    .prepare("SELECT id FROM conversation_checkpoint_operations ORDER BY id")
    .pluck()
    .all() as string[];
}

function payloadIds(): string[] {
  return fx.db
    .prepare("SELECT id FROM conversation_checkpoints ORDER BY id")
    .pluck()
    .all() as string[];
}

function seedContextArtifact(conversationId: string, artifactId: string): void {
  fx.db
    .prepare(
      `INSERT INTO context_artifacts (
         id, kind, scope, project_path, session_name, conversation_id,
         covered_start_seq, covered_end_seq, source_hash, status, backend,
         model_selection_json, schema_version, prompt_version,
         normalizer_version, created_by, payload_json, created_at, updated_at
       ) VALUES (?, 'conversation_compaction', 'session', ?, ?, ?, 1, 200,
                 'sha256:artifact', 'complete', 'claude', ?, 1, 'p1', 'n1',
                 'user', ?, ?, ?)`,
    )
    .run(
      artifactId,
      PROJECT,
      SESSION,
      conversationId,
      JSON.stringify({ kind: "alias", alias: "sonnet" }),
      JSON.stringify({
        sections: [{ heading: "Working state", body: "kept" }],
      }),
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
    );
}

describe("checkpoint deletion ownership", () => {
  it("removes a session conversation's checkpoints when the conversation row is deleted, and leaves a sibling's alone", async () => {
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-target"));
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-sibling"));
    seedCheckpoint({
      operationId: "op-target",
      scope: "session",
      conversationId: "conv-target",
    });
    seedCheckpoint({
      operationId: "op-sibling",
      scope: "session",
      conversationId: "conv-sibling",
    });

    // The shape `conversations/service.ts deleteConversation` commits: the
    // conversation leaves its session's collection and the focused mutate
    // removes the row.
    await fx.store.mutateSession(
      PROJECT,
      SESSION,
      "deleteConversation",
      (session) => {
        session.conversations = session.conversations.filter(
          (candidate) => candidate.id !== "conv-target",
        );
      },
    );

    expect(operationIds()).toEqual(["op-sibling"]);
    expect(payloadIds()).toEqual(["op-sibling"]);
  });

  it("removes every conversation's checkpoints when the owning session is deleted", async () => {
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    fx.seedSession(PROJECT, SIBLING_SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-a"));
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-b"));
    await fx.seedConversation(
      PROJECT,
      SIBLING_SESSION,
      conversation("conv-kept"),
    );
    seedCheckpoint({
      operationId: "op-a",
      scope: "session",
      conversationId: "conv-a",
    });
    seedCheckpoint({
      operationId: "op-b",
      scope: "session",
      conversationId: "conv-b",
    });
    seedCheckpoint({
      operationId: "op-kept",
      scope: "session",
      sessionName: SIBLING_SESSION,
      conversationId: "conv-kept",
    });

    await fx.store.deleteSessionRow(PROJECT, SESSION, "deleteSession");

    expect(operationIds()).toEqual(["op-kept"]);
    expect(payloadIds()).toEqual(["op-kept"]);
  });

  it("removes checkpoints for every session in a fused delete", async () => {
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    fx.seedSession(PROJECT, SIBLING_SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-a"));
    await fx.seedConversation(PROJECT, SIBLING_SESSION, conversation("conv-b"));
    seedCheckpoint({
      operationId: "op-a",
      scope: "session",
      conversationId: "conv-a",
    });
    seedCheckpoint({
      operationId: "op-b",
      scope: "session",
      sessionName: SIBLING_SESSION,
      conversationId: "conv-b",
    });

    await fx.store.applyFusedSessionDelete(
      PROJECT,
      [SESSION, SIBLING_SESSION],
      "applyFusedSessionDelete",
    );

    expect(operationIds()).toEqual([]);
    expect(payloadIds()).toEqual([]);
  });

  it("removes both session- and project-scoped checkpoints when the project is deleted, and spares another project", async () => {
    fx.seedProject(PROJECT);
    fx.seedProject(OTHER_PROJECT);
    fx.seedSession(PROJECT, SESSION);
    fx.seedSession(OTHER_PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-session"));
    await fx.seedProjectConversation(PROJECT, conversation("conv-project"));
    await fx.seedConversation(
      OTHER_PROJECT,
      SESSION,
      conversation("conv-bystander"),
    );
    seedCheckpoint({
      operationId: "op-session",
      scope: "session",
      conversationId: "conv-session",
    });
    seedCheckpoint({
      operationId: "op-project",
      scope: "project",
      conversationId: "conv-project",
    });
    seedCheckpoint({
      operationId: "op-bystander",
      scope: "session",
      projectPath: OTHER_PROJECT,
      conversationId: "conv-bystander",
    });

    await fx.store.deleteProjectRow(PROJECT, [], "2026-09-02T00:00:00Z");

    expect(operationIds()).toEqual(["op-bystander"]);
    expect(payloadIds()).toEqual(["op-bystander"]);
  });

  it("keeps a project-scoped checkpoint when a same-id session conversation is deleted", async () => {
    // The two scopes mint ids independently, so a collision is possible; the
    // cleanup triggers must discriminate on scope, not on conversation id alone.
    const sharedId = "conv-collision";
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation(sharedId));
    await fx.seedProjectConversation(PROJECT, conversation(sharedId));
    seedCheckpoint({
      operationId: "op-session-scope",
      scope: "session",
      conversationId: sharedId,
    });
    seedCheckpoint({
      operationId: "op-project-scope",
      scope: "project",
      conversationId: sharedId,
    });

    await fx.store.deleteSessionRow(PROJECT, SESSION, "deleteSession");

    expect(operationIds()).toEqual(["op-project-scope"]);
  });
});

describe("checkpoint retention across archiving and compaction", () => {
  it("retains checkpoint records and their payloads when the conversation is archived", async () => {
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-archived"));
    seedCheckpoint({
      operationId: "op-archived",
      scope: "session",
      conversationId: "conv-archived",
    });

    await fx.store.mutateConversation(
      PROJECT,
      SESSION,
      "conv-archived",
      "archiveConversation",
      (target) => {
        target.archived = true;
      },
    );

    expect(operationIds()).toEqual(["op-archived"]);
    expect(payloadIds()).toEqual(["op-archived"]);
  });

  it("retains checkpoint records and the compaction artifact when the conversation is compacted", async () => {
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-compacted"));
    seedCheckpoint({
      operationId: "op-compacted",
      scope: "session",
      conversationId: "conv-compacted",
    });

    seedContextArtifact("conv-compacted", "artifact-rolling");

    expect(operationIds()).toEqual(["op-compacted"]);
    expect(payloadIds()).toEqual(["op-compacted"]);
    expect(
      fx.db
        .prepare("SELECT payload_json FROM context_artifacts WHERE id = ?")
        .pluck()
        .get("artifact-rolling"),
    ).toContain("Working state");
  });

  /**
   * Image assets are files, not rows, so the cleanup triggers cannot reach
   * them — but that is the claim, and a later retention feature that pruned a
   * compacted conversation's images on disk would break continuity evidence
   * without touching a single test above. This asserts the bytes survive both
   * operations that legitimately shrink a conversation's live context.
   */
  it("retains stored transcript image bytes across archiving and compaction", async () => {
    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-images"));
    seedCheckpoint({
      operationId: "op-images",
      scope: "session",
      conversationId: "conv-images",
    });
    const imagePath = await saveTranscriptImage(
      "conv-images",
      1,
      "image/png",
      pixel,
      configDir,
    );

    await fx.store.mutateConversation(
      PROJECT,
      SESSION,
      "conv-images",
      "archiveConversation",
      (target) => {
        target.archived = true;
      },
    );
    seedContextArtifact("conv-images", "artifact-images");

    expect(operationIds()).toEqual(["op-images"]);
    expect(await readTranscriptImage(imagePath)).toBe(pixel);
  });

  it("retains checkpoint records when the owning session is archived", async () => {
    fx.seedProject(PROJECT);
    fx.seedSession(PROJECT, SESSION);
    await fx.seedConversation(PROJECT, SESSION, conversation("conv-live"));
    seedCheckpoint({
      operationId: "op-live",
      scope: "session",
      conversationId: "conv-live",
    });

    await fx.store.mutateSession(PROJECT, SESSION, "archiveSession", (s) => {
      s.archived = true;
    });

    expect(operationIds()).toEqual(["op-live"]);
  });
});
