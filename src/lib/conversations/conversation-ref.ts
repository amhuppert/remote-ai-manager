import { escapeXmlAttr } from "@/lib/shared/xml";
import type {
  ConversationCompactStatus,
  ConversationListItem,
  ConversationStatus,
} from "./schemas";

/**
 * CamelCase attribute set behind a `<conversation-ref ... />` tag — the same
 * shape the prompt editor's `conversationMention` node stores, so a built ref
 * and a pasted chip round-trip through one attribute vocabulary. Absent values
 * are empty strings (the node persists every attribute as a string).
 */
export interface ConversationRefBuilderAttrs {
  projectName: string;
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  conversationName: string;
  backend: "claude" | "codex";
  backendRef: string;
  /** Not carried on the wire — the serializer omits it. */
  transcriptPath: string;
  debugLogPath: string;
  status: ConversationStatus;
  lastActivityAt: string;
  compactArtifactId: string;
  compactStatus: ConversationCompactStatus;
  compactCoveredSeq: string;
  compactCreatedAt: string;
}

const CONVERSATION_REF_ATTR_ORDER: ReadonlyArray<[string, string]> = [
  ["projectName", "project-name"],
  ["projectPath", "project-path"],
  ["sessionName", "session-name"],
  ["worktreePath", "worktree-path"],
  ["conversationId", "conversation-id"],
  ["conversationName", "conversation-name"],
  ["backend", "backend"],
  ["backendRef", "backend-ref"],
  ["debugLogPath", "debug-log-path"],
  ["status", "status"],
  ["lastActivityAt", "last-activity-at"],
  ["compactArtifactId", "compact-artifact-id"],
  ["compactStatus", "compact-status"],
  ["compactCoveredSeq", "compact-covered-seq"],
  ["compactCreatedAt", "compact-created-at"],
];

// Emitted only when a completed conversation compaction exists; refs without
// one carry compact-status="none" alone to keep the XML lean (design §12.4).
const COMPACTION_DETAIL_ATTRS = new Set([
  "compactArtifactId",
  "compactCoveredSeq",
  "compactCreatedAt",
]);

/**
 * Ready-to-run `cctl` commands a reading agent can copy verbatim. cctl resolves
 * the owning project/session from the id, so these need no flags. Compaction
 * first (the dense structured summary) when one exists, then the windowed read.
 */
function conversationReadCommands(
  conversationId: string,
  compactStatus: "none" | "fresh" | "stale",
): Array<[string, string]> {
  const commands: Array<[string, string]> = [];
  if (compactStatus !== "none") {
    commands.push([
      "compaction-command",
      `cctl conversation compaction get ${conversationId} --json`,
    ]);
  }
  commands.push([
    "read-command",
    `cctl conversation read ${conversationId} --outline`,
  ]);
  return commands;
}

/**
 * Render the canonical self-closing `<conversation-ref ... />` XML tag from
 * camelCase attributes. Accepts an untyped record because the prompt-editor
 * serializer feeds it raw node attributes; non-string values render as "".
 */
export function buildConversationRefXml(
  attrs: Record<string, unknown>,
): string {
  const rawStatus = attrs["compactStatus"];
  const compactStatus =
    rawStatus === "fresh" || rawStatus === "stale" ? rawStatus : "none";
  const parts: string[] = ["<conversation-ref"];
  for (const [camel, kebab] of CONVERSATION_REF_ATTR_ORDER) {
    if (camel === "compactStatus") {
      parts.push(`${kebab}="${compactStatus}"`);
      continue;
    }
    if (COMPACTION_DETAIL_ATTRS.has(camel) && compactStatus === "none") {
      continue;
    }
    const raw = attrs[camel];
    const value = typeof raw === "string" ? raw : "";
    parts.push(`${kebab}="${escapeXmlAttr(value)}"`);
  }
  const rawId = attrs["conversationId"];
  const conversationId = typeof rawId === "string" ? rawId : "";
  for (const [kebab, command] of conversationReadCommands(
    conversationId,
    compactStatus,
  )) {
    parts.push(`${kebab}="${escapeXmlAttr(command)}"`);
  }
  return `${parts.join(" ")} />`;
}

/**
 * Map a `ConversationListItem` (the cross-project addressable-conversation
 * projection) onto the camelCase ref/mention attribute set. Shared by the
 * prompt editor's `#` picker and the context menu's Copy-reference action so
 * both emit identical metadata.
 */
export function conversationListItemToMentionAttrs(
  item: ConversationListItem,
): ConversationRefBuilderAttrs {
  return {
    projectName: item.projectName,
    projectPath: item.projectPath,
    sessionName: item.sessionName,
    worktreePath: item.worktreePath,
    conversationId: item.conversationId,
    conversationName: item.conversationName ?? "",
    backend: item.backend,
    backendRef: item.backendRef?.ref ?? "",
    transcriptPath: item.transcriptPath ?? "",
    debugLogPath: item.debugLogPath ?? "",
    status: item.status,
    lastActivityAt: item.lastActivityAt,
    compactArtifactId: item.compactArtifactId ?? "",
    compactStatus: item.compactStatus ?? "none",
    compactCoveredSeq: item.compactCoveredSeq ?? "",
    compactCreatedAt: item.compactCreatedAt ?? "",
  };
}

/** Build the canonical `<conversation-ref ... />` tag for a list item. */
export function buildConversationRefXmlFromListItem(
  item: ConversationListItem,
): string {
  return buildConversationRefXml({
    ...conversationListItemToMentionAttrs(item),
  });
}
