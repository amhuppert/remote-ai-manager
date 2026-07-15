import type { SpawnCardRowData } from "@/features/project-detail/cockpit/spawn-card-slot";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import {
  extractProposal,
  validateProposal,
  SPAWN_PROPOSAL_FENCE,
  type ProposalValidation,
} from "@/lib/chat-spawning/proposal-validator";
import type { SpawnedSessionStatus } from "./SpawnCard";

/**
 * The spawn cards derived from a project conversation's transcript, plus the
 * validated proposal each card resolves to. Stateless: the proposal lives in
 * the agent's persisted turn text, so the cards re-derive identically on every
 * render from the messages alone.
 */
export interface DerivedSpawnCards {
  spawnCards: SpawnCardRowData[];
  validations: Map<string, ProposalValidation>;
}

/**
 * Stable, index-derived id for the proposal a given assistant message carries.
 * The transcript is append-only, so a proposing message keeps its index — and
 * therefore this id — across re-renders and SSE appends.
 */
export function spawnProposalId(messageIndex: number): string {
  return `proposal-${messageIndex}`;
}

function assistantText(msg: TranscriptMessage): string {
  let text = "";
  for (const block of msg.content) {
    if (block.type === "text") {
      text += (text.length > 0 ? "\n" : "") + block.text;
    }
  }
  return text;
}

/**
 * Scan a conversation's transcript for agent-emitted spawn proposals. Only
 * assistant turns are inspected (the agent proposes; a user typing the fence is
 * not a proposal). Each proposal becomes a card anchored at its message, and is
 * validated up front so the card can render its valid/invalid state without
 * re-running validation. Pure — no I/O, never throws.
 */
export function deriveSpawnCards(
  messages: readonly TranscriptMessage[],
): DerivedSpawnCards {
  const spawnCards: SpawnCardRowData[] = [];
  const validations = new Map<string, ProposalValidation>();

  messages.forEach((msg, index) => {
    if (msg.role !== "assistant") return;
    const candidate = extractProposal(assistantText(msg));
    if (candidate === null) return;
    const proposalId = spawnProposalId(index);
    spawnCards.push({
      kind: "spawn-card",
      proposalId,
      anchorMessageIndex: index,
    });
    validations.set(proposalId, validateProposal(candidate));
  });

  return { spawnCards, validations };
}

/**
 * The live status of every session a project conversation has spawned, read
 * from the existing sessions signal (SSE-fresh). The card cross-references its
 * own created session names against this list, so passing the conversation's
 * full spawned set is sufficient — passive, never driving the sessions. Pure.
 */
export function selectSpawnedSessionStatuses(
  sessions: readonly SessionListItem[],
  conversationId: string | null,
): SpawnedSessionStatus[] {
  if (conversationId === null) return [];
  return sessions
    .filter((s) => s.spawnedFrom?.conversationId === conversationId)
    .map((s) => ({
      sessionName: s.sessionName,
      derivedStatus: s.derivedStatus,
    }));
}

const PROPOSAL_FENCE_RE = new RegExp(
  "```" + SPAWN_PROPOSAL_FENCE + "\\s*\\n[\\s\\S]*?\\n```",
  "g",
);

function stripProposalFenceFromText(text: string): string {
  return text
    .replace(PROPOSAL_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove `spawn-proposal` fenced blocks from a message's text content so the
 * raw proposal JSON is not rendered alongside the inline card it produces.
 * Surrounding prose is preserved; a text block that was nothing but the fence is
 * dropped; non-text blocks pass through untouched. Pure.
 */
export function stripProposalFencesFromContent(
  content: readonly MessageContentBlock[],
): MessageContentBlock[] {
  const out: MessageContentBlock[] = [];
  for (const block of content) {
    if (block.type !== "text") {
      out.push(block);
      continue;
    }
    const stripped = stripProposalFenceFromText(block.text);
    if (stripped.length > 0) {
      out.push({ type: "text", text: stripped });
    }
  }
  return out;
}
