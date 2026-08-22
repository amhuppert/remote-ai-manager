/**
 * R2.1 / R12.3 — a registered Cursor conversation survives a restart.
 *
 * Registration is only real if the canonical backend value and the eagerly
 * persisted opaque ref come back off disk unchanged, through the SAME text
 * columns Claude and Codex already use — no migration, no new column, and no
 * regression for rows written before Cursor existed.
 *
 * The reads go through a store built AFTER the writes (`recreateStore`) and a
 * transcript reader with its cache cleared, so every assertion is about what a
 * restarted server loads rather than what this process still holds in memory.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "./testing/conversation-state-fixture";
import { selectLastUserTurnAgentSettings } from "./last-turn-agent-settings";
import {
  appendTranscriptEntry,
  readConversationMessages,
  _resetTranscriptReadCacheForTesting,
  _resetLastSeqCacheForTesting,
} from "@/lib/prompt/transcript";
import type { ConversationState } from "./schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

const PROJECT_PATH = "/repo-cursor-restart";
const SESSION_NAME = "cursor-restart-session";
const CURSOR_MODEL = "composer-2.5";

let fixture: PersistenceFixture;
let configDir: string;

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  configDir = await mkdtemp(join(tmpdir(), "cursor-restart-"));
  _resetTranscriptReadCacheForTesting();
  _resetLastSeqCacheForTesting();
});

afterEach(async () => {
  fixture.close();
  await rm(configDir, { recursive: true, force: true });
});

function conversationFor(
  id: string,
  backend: AgentBackendId,
  ref: string,
): ConversationState {
  return makeConversationState({
    id,
    agentBackend: backend,
    backendRef: { backend, ref },
    transcriptPath: null,
  });
}

/** Reload through a store built after the write — the restart reader. */
async function reload(conversationId: string): Promise<ConversationState> {
  const conversation = await fixture
    .recreateStore()
    .getConversation(PROJECT_PATH, SESSION_NAME, conversationId);
  if (conversation === null) {
    throw new Error(
      `the restart reader found no conversation ${conversationId}`,
    );
  }
  return conversation;
}

describe("cursor conversation restart durability", () => {
  it("reloads the cursor backend value and opaque ref alongside untouched claude/codex rows", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationFor("conv-claude", "claude", "sess-legacy-claude"),
    );
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationFor("conv-codex", "codex", "thr-legacy-codex"),
    );
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationFor("conv-cursor", "cursor", "agent-cursor-eager-ref"),
    );

    const cursor = await reload("conv-cursor");
    expect(cursor.agentBackend).toBe("cursor");
    expect(cursor.backendRef).toEqual({
      backend: "cursor",
      ref: "agent-cursor-eager-ref",
    });

    const claude = await reload("conv-claude");
    expect(claude.agentBackend).toBe("claude");
    expect(claude.backendRef).toEqual({
      backend: "claude",
      ref: "sess-legacy-claude",
    });

    const codex = await reload("conv-codex");
    expect(codex.agentBackend).toBe("codex");
    expect(codex.backendRef).toEqual({
      backend: "codex",
      ref: "thr-legacy-codex",
    });
  });

  it("reloads a project-scoped cursor conversation from the project-conversations repo", async () => {
    await fixture.seedProjectConversation(PROJECT_PATH, {
      ...conversationFor("plc-cursor", "cursor", "agent-plc-ref"),
      scope: "project",
      open: true,
    });

    const reloaded = await fixture
      .recreateStore()
      .getProjectConversation(PROJECT_PATH, "plc-cursor");
    if (reloaded === null) {
      throw new Error("the restart reader found no project-level conversation");
    }
    expect(reloaded.agentBackend).toBe("cursor");
    expect(reloaded.backendRef).toEqual({
      backend: "cursor",
      ref: "agent-plc-ref",
    });
  });

  it("reloads the selected cursor model from the durable transcript", async () => {
    const conversationId = "conv-cursor-model";
    await appendTranscriptEntry(
      conversationId,
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hello cursor" }],
        model: CURSOR_MODEL,
      },
      configDir,
    );

    const transcriptPath = join(
      configDir,
      "transcripts",
      `${conversationId}.jsonl`,
    );
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      makeConversationState({
        id: conversationId,
        agentBackend: "cursor",
        backendRef: { backend: "cursor", ref: "agent-model-ref" },
        transcriptPath,
      }),
    );

    _resetTranscriptReadCacheForTesting();
    const reloaded = await reload(conversationId);
    const messages = await readConversationMessages(reloaded.transcriptPath);

    expect(selectLastUserTurnAgentSettings(messages)).toEqual({
      modelId: CURSOR_MODEL,
    });
  });

  it("requires no schema migration: the seeded rows load on the shipped DDL", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationFor("conv-cursor-ddl", "cursor", "agent-ddl-ref"),
    );

    const row = fixture.db
      .prepare(
        "SELECT agent_backend, backend_ref FROM conversations WHERE id = ?",
      )
      .get("conv-cursor-ddl") as {
      agent_backend: string;
      backend_ref: string | null;
    };

    // The existing TEXT columns carry the new backend as-is; a registration
    // that needed a migration would show up here as a different storage shape.
    expect(row.agent_backend).toBe("cursor");
    expect(JSON.parse(row.backend_ref ?? "null")).toEqual({
      backend: "cursor",
      ref: "agent-ddl-ref",
    });
  });
});
