import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import {
  projectEventIdentity,
  sessionEventIdentity,
  sourceRefSchema,
} from "@/lib/conversations/schemas";

/**
 * Envelope schema version stamped into `context_artifacts.schema_version`.
 * Graduating a field out of `extras` into a typed top-level field bumps this
 * (design docs/design/conversation-compaction/README.md §6.1).
 */
export const CONTEXT_ARTIFACT_SCHEMA_VERSION = 1;

export const artifactKindSchema = z.enum([
  "message_compaction",
  "conversation_compaction",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const decisionSchema = z.object({
  statement: z.string(),
  rationale: z.string().optional(),
  status: z
    .enum(["proposed", "accepted", "rejected", "superseded"])
    .default("accepted"),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export type Decision = z.infer<typeof decisionSchema>;

export const fileEntrySchema = z.object({
  path: z.string(),
  role: z.enum(["created", "modified", "deleted", "read", "discussed"]),
  details: z.string().optional(),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const commandEntrySchema = z.object({
  command: z.string(),
  outcome: z.enum(["succeeded", "failed", "mixed", "unknown"]),
  summary: z.string().optional(),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export type CommandEntry = z.infer<typeof commandEntrySchema>;

export const anchoredNoteSchema = z.object({
  text: z.string(),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export type AnchoredNote = z.infer<typeof anchoredNoteSchema>;

/**
 * The structured compaction payload stored whole in
 * `context_artifacts.payload_json`. Carries `.default()` effects (sparse model
 * output decodes cleanly), so it must never be registered as a trusted
 * effect-free schema — reads go through `safeParse`.
 */
export const compactionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: artifactKindSchema,
  source: z.object({
    projectName: z.string(),
    sessionName: z.string().nullable(),
    conversationId: z.string(),
    coveredStartSeq: z.number().int(),
    coveredEndSeq: z.number().int(),
    messageCount: z.number().int(),
    sourceHash: z.string(),
  }),
  agentBrief: z.string(),
  currentState: z.object({
    status: z.string(),
    latestUserGoal: z.string(),
    nextBestActions: z.array(z.string()),
  }),
  decisions: z.array(decisionSchema).default([]),
  files: z.array(fileEntrySchema).default([]),
  commands: z.array(commandEntrySchema).default([]),
  openQuestions: z.array(anchoredNoteSchema).default([]),
  blockers: z.array(anchoredNoteSchema).default([]),
  omissions: z.object({
    reasoningOmitted: z.boolean(),
    largeToolOutputsElided: z.number().int(),
  }),
  extras: z.record(z.string(), z.unknown()).default({}),
});
export type CompactionEnvelope = z.infer<typeof compactionEnvelopeSchema>;

export const contextArtifactStatusSchema = z.enum([
  "pending",
  "complete",
  "failed",
]);

export const createdBySchema = z.enum(["user", "agent"]);
export type ContextArtifactCreatedBy = z.infer<typeof createdBySchema>;

/**
 * Mirrors the conversation scope discriminator without inheriting its
 * `.default("session")` effect — a context-artifact row always states its
 * scope explicitly.
 */
export const contextArtifactScopeSchema = z.enum(["session", "project"]);
export type ContextArtifactScope = z.infer<typeof contextArtifactScopeSchema>;

/**
 * Domain shape of one `context_artifacts` row (camelCase). `payload` is the
 * parsed `payload_json` envelope — null while the artifact is pending or
 * failed. All timestamps are caller-supplied ISO-8601 strings.
 */
/**
 * SSE progress event for compaction runs (design §9.1), following the
 * conversation-domain dual-scope pattern: a `scope`-discriminated union whose
 * project variant carries no `sessionName`. Neither member is `.strict()`:
 * the SSE broadcaster stamps envelope fields (`_sentAt`) into every frame,
 * and client-side `safeParse` must tolerate-and-strip them or the event is
 * silently dropped.
 */
export const contextArtifactStatusEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("context_artifact_status"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    artifactId: z.string(),
    kind: artifactKindSchema,
    status: contextArtifactStatusSchema,
    messageIndex: z.number().int().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("context_artifact_status"),
    ...projectEventIdentity,
    conversationId: z.string(),
    artifactId: z.string(),
    kind: artifactKindSchema,
    status: contextArtifactStatusSchema,
    messageIndex: z.number().int().optional(),
    error: z.string().optional(),
  }),
]);
export type ContextArtifactStatusEvent = z.infer<
  typeof contextArtifactStatusEventSchema
>;

export const contextArtifactRowSchema = z
  .object({
    id: z.string().min(1),
    kind: artifactKindSchema,
    scope: contextArtifactScopeSchema,
    projectPath: z.string().min(1),
    sessionName: z.string().nullable(),
    conversationId: z.string().min(1),
    messageId: z.string().nullable(),
    messageIndex: z.number().int().nullable(),
    coveredStartSeq: z.number().int(),
    coveredEndSeq: z.number().int(),
    sourceHash: z.string(),
    status: contextArtifactStatusSchema,
    error: z.string().nullable(),
    backend: agentBackendSchema,
    modelSelection: backendModelSelectionSchema,
    schemaVersion: z.number().int(),
    promptVersion: z.string(),
    normalizerVersion: z.string(),
    createdBy: createdBySchema,
    createdByConversationId: z.string().nullable(),
    payload: compactionEnvelopeSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ContextArtifactRow = z.infer<typeof contextArtifactRowSchema>;
