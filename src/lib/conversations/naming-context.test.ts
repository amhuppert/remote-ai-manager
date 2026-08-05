import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionEnvelopeToMarkdown } from "@/lib/context-artifacts/render-markdown";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  compactionEnvelopeSchema,
  contextArtifactRowSchema,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";
import {
  resolveConversationNamingContent,
  resolveMessageNamingContent,
  type NamingContextDeps,
} from "./naming-context";

const CONVERSATION_ID = "conversation-naming-context";

function transcriptEntry(
  id: string,
  role: "user" | "assistant",
  content: Array<Record<string, unknown>>,
) {
  return {
    id,
    timestamp: "2026-08-04T12:00:00.000Z",
    type: role,
    role,
    content,
  };
}

function textEntry(id: string, role: "user" | "assistant", text: string) {
  return transcriptEntry(id, role, [{ type: "text", text }]);
}

function buildEnvelope(
  overrides: Partial<CompactionEnvelope> = {},
): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "command-center",
      sessionName: "naming-context",
      conversationId: CONVERSATION_ID,
      coveredStartSeq: 0,
      coveredEndSeq: 2,
      messageCount: 3,
      sourceHash: "source-hash",
    },
    agentBrief: "Fresh compacted naming basis.",
    currentState: {
      status: "implementation_in_progress",
      latestUserGoal: "Implement conversation naming context.",
      nextBestActions: ["Finish the bounded renderer"],
    },
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
    extras: {},
    ...overrides,
  });
}

function buildArtifact(
  overrides: Partial<ContextArtifactRow> = {},
): ContextArtifactRow {
  const payload = buildEnvelope();
  return contextArtifactRowSchema.parse({
    id: "artifact-conversation-naming",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/projects/command-center",
    sessionName: "naming-context",
    conversationId: CONVERSATION_ID,
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: payload.source.coveredEndSeq,
    sourceHash: payload.source.sourceHash,
    status: "complete",
    error: null,
    modelProvider: "claude",
    model: "haiku",
    effort: null,
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: "1",
    normalizerVersion: "1",
    createdBy: "user",
    createdByConversationId: null,
    payload,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:01:00.000Z",
    ...overrides,
  });
}

function depsWithArtifacts(artifacts: ContextArtifactRow[]): NamingContextDeps {
  return {
    findArtifacts(conversationId) {
      expect(conversationId).toBe(CONVERSATION_ID);
      return artifacts;
    },
  };
}

let tempDirectory: string;
let transcriptCounter: number;

async function writeTranscript(entries: unknown[]): Promise<string> {
  const transcriptPath = join(
    tempDirectory,
    `transcript-${transcriptCounter++}.jsonl`,
  );
  await writeFile(
    transcriptPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return transcriptPath;
}

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), "naming-context-"));
  transcriptCounter = 0;
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("resolveConversationNamingContent", () => {
  it("prefers a complete compaction artifact covering the transcript max seq", async () => {
    const transcriptPath = await writeTranscript([
      textEntry("message-0", "user", "raw first prompt"),
      textEntry("message-1", "assistant", "raw first response"),
      textEntry("message-2", "user", "raw second prompt"),
    ]);
    const artifact = buildArtifact();

    const content = await resolveConversationNamingContent(
      { conversationId: CONVERSATION_ID, transcriptPath },
      depsWithArtifacts([artifact]),
    );

    const payload = artifact.payload;
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(content).toBe(
      compactionEnvelopeToMarkdown(payload, {
        stale: false,
        staleBehindMessages: 0,
        outdated: false,
        updatedAt: artifact.updatedAt,
      }),
    );
    expect(content).toContain("Fresh compacted naming basis.");
    expect(content).not.toContain("raw first prompt");
  });

  it("falls back to the compact transcript when the artifact is stale", async () => {
    const transcriptPath = await writeTranscript([
      textEntry("message-0", "user", "first raw prompt"),
      textEntry("message-1", "assistant", "first raw response"),
      textEntry("message-2", "user", "latest raw prompt"),
    ]);
    const artifact = buildArtifact({ coveredEndSeq: 1 });

    const content = await resolveConversationNamingContent(
      { conversationId: CONVERSATION_ID, transcriptPath },
      depsWithArtifacts([artifact]),
    );

    expect(content).toContain("first raw prompt");
    expect(content).toContain("latest raw prompt");
    expect(content).not.toContain("Fresh compacted naming basis.");
  });

  it("falls back to the compact transcript when no artifact exists", async () => {
    const transcriptPath = await writeTranscript([
      textEntry("message-0", "user", "name this fallback conversation"),
      textEntry("message-1", "assistant", "working on the fallback"),
    ]);

    const content = await resolveConversationNamingContent(
      { conversationId: CONVERSATION_ID, transcriptPath },
      depsWithArtifacts([]),
    );

    expect(content).toContain("#0 [seq 0] user");
    expect(content).toContain("name this fallback conversation");
    expect(content).toContain("#1 [seq 1] assistant");
  });

  it("uses tool summaries and truncates conversation rendering at the 24576-byte budget", async () => {
    const oversizedLines = Array.from(
      { length: 1_500 },
      (_, index) => `oversized naming context line ${index}`,
    ).join("\n");
    const transcriptPath = await writeTranscript([
      transcriptEntry("message-0", "user", [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { path: "src/lib/conversations/naming-context.ts" },
        },
        { type: "text", text: oversizedLines },
      ]),
    ]);

    const content = await resolveConversationNamingContent(
      { conversationId: CONVERSATION_ID, transcriptPath },
      depsWithArtifacts([]),
    );

    expect(content).toContain("⚙ Read(");
    expect(content).toContain("… [output truncated]");
    expect(content).not.toContain("oversized naming context line 1499");
  });

  it("returns null when the transcript path is missing", async () => {
    await expect(
      resolveConversationNamingContent(
        { conversationId: CONVERSATION_ID, transcriptPath: null },
        depsWithArtifacts([]),
      ),
    ).resolves.toBeNull();
  });
});

describe("resolveMessageNamingContent", () => {
  it("renders exactly messageRange N:N without tools and with the 16384-byte budget", async () => {
    const oversizedMessage = Array.from(
      { length: 1_000 },
      (_, index) => `selected assistant line ${index}`,
    ).join("\n");
    const transcriptPath = await writeTranscript([
      textEntry("message-0", "user", "unselected user message"),
      transcriptEntry("message-1", "assistant", [
        { type: "text", text: oversizedMessage },
        {
          type: "tool_use",
          id: "tool-2",
          name: "Read",
          input: { path: "secret-tool-detail.ts" },
        },
      ]),
      textEntry("message-2", "user", "unselected later message"),
    ]);

    const content = await resolveMessageNamingContent({
      transcriptPath,
      messageIndex: 1,
    });

    expect(content).toContain("#1 [seq 1] assistant");
    expect(content).toContain("selected assistant line 0");
    expect(content).toContain("… [output truncated]");
    expect(content).not.toContain("#0 [seq 0] user");
    expect(content).not.toContain("#2 [seq 2] user");
    expect(content).not.toContain("Read(");
    expect(content).not.toContain("secret-tool-detail.ts");
  });

  it.each([
    { transcriptPath: null, messageIndex: 0 },
    { transcriptPath: "/path/that/does/not/exist.jsonl", messageIndex: 0 },
  ])("returns null for a missing transcript", async (input) => {
    await expect(resolveMessageNamingContent(input)).resolves.toBeNull();
  });

  it("returns null for an out-of-range message index", async () => {
    const transcriptPath = await writeTranscript([
      textEntry("message-0", "user", "the only message"),
    ]);

    await expect(
      resolveMessageNamingContent({ transcriptPath, messageIndex: 4 }),
    ).resolves.toBeNull();
  });
});
