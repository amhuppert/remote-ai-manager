import { conversationTargetScopeLabel } from "@/lib/conversations/conversation-target";
import { conversationListItemTarget } from "@/lib/conversations/schemas";
import { createElement, type ComponentType } from "react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { ZodType } from "zod";
import ConversationMentionChip from "@/features/session/conversation/ConversationMentionChip";
import ConversationLinkChip from "@/features/session/conversation/ConversationLinkChip";
import MessageMentionChip from "@/features/session/conversation/MessageMentionChip";
import MessageRefLinkChip from "@/features/session/conversation/MessageRefLinkChip";
import TicketMentionChip from "@/features/session/conversation/TicketMentionChip";
import TicketRefLinkChip from "@/features/session/conversation/TicketRefLinkChip";
import {
  SpecElementRefTranscriptChip,
  SpecRefEditorChip,
  SpecRefTranscriptChip,
} from "@/components/references/SpecRefChips";
import {
  buildConversationRefXml,
  conversationListItemToMentionAttrs,
} from "@/lib/conversations/conversation-ref";
import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import { filterAndScoreConversations } from "@/lib/conversations/conversation-autocomplete-filter";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import {
  conversationRefAttrsSchema,
  messageRefAttrsSchema,
  type ConversationListItem,
} from "@/lib/conversations/schemas";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { filterAndScoreTickets } from "@/lib/tickets/ticket-autocomplete-filter";
import {
  ticketRefAttrsSchema,
  type TicketListItem,
} from "@/lib/tickets/schemas";
import { conversationRefAttrsToMentionAttrs } from "./conversation-mention-node";
import { messageRefAttrsToMentionAttrs } from "./message-mention-node";
import { ticketRefAttrsToMentionAttrs } from "./ticket-mention-node";
import {
  buildSpecReadCommand,
  buildSpecReferenceXml,
  specElementRefAttrsSchema,
  specElementRefAttrsToMentionAttrs,
  specRefAttrsSchema,
  specRefAttrsToMentionAttrs,
} from "./spec-mention-nodes";

export type ReferenceType =
  | "conversation"
  | "ticket"
  | "message"
  | "spec"
  | "requirement"
  | "decision"
  | "task"
  | "question"
  | "assumption";
export type ReferenceNodeName =
  | "conversationMention"
  | "ticketMention"
  | "messageMention"
  | "specMention"
  | "requirementMention"
  | "decisionMention"
  | "taskMention"
  | "questionMention"
  | "assumptionMention";
export type ReferenceXmlTag =
  | "conversation-ref"
  | "ticket-ref"
  | "message-ref"
  | "spec-ref"
  | "requirement-ref"
  | "decision-ref"
  | "task-ref"
  | "question-ref"
  | "assumption-ref";

export interface ReferencePickerSource {
  groupLabel: string;
  queryAliases: readonly string[];
  getItems(
    query: string,
    context: ReferencePickerContext,
  ): ReferencePickerItem[];
}

export interface ReferencePickerContext {
  currentProjectName: string | null;
  currentConversationId: string | null;
  conversations: readonly ConversationListItem[];
  tickets: readonly TicketListItem[];
  specs: readonly SpecPickerSpec[];
  selectedSpec: SpecPickerSpec | null;
}

export interface SpecPickerElement {
  type: "requirement" | "decision" | "task" | "question" | "assumption";
  elementId: string;
  handle: string;
  name: string;
  searchText: string;
}

export interface SpecPickerSpec {
  projectName: string;
  specId: string;
  slug: string;
  name: string;
  revision: number;
  elements: readonly SpecPickerElement[];
}

export interface ReferencePickerItem {
  type: ReferenceType;
  id: string;
  label: string;
  description: string;
  matchIndices: number[];
  attrs: Record<string, unknown>;
}

type EditorChipComponent = ComponentType<ReactNodeViewProps<HTMLElement>>;
type TranscriptChipComponent = ComponentType<{ attrs: unknown }>;

export interface ReferenceRegistryEntry {
  type: ReferenceType;
  nodeName: ReferenceNodeName;
  xmlTag: ReferenceXmlTag;
  attrsSchema: ZodType;
  buildXml(attrs: Record<string, unknown>): string;
  parseAttrs(attrs: unknown): Record<string, unknown>;
  EditorChip: EditorChipComponent;
  TranscriptChip: TranscriptChipComponent;
  pickerSource: ReferencePickerSource;
}

function transcriptChip<TAttrs>(
  schema: ZodType<TAttrs>,
  Chip: ComponentType<{ attrs: TAttrs }>,
): TranscriptChipComponent {
  return function RegisteredTranscriptChip({ attrs }) {
    return createElement(Chip, { attrs: schema.parse(attrs) });
  };
}

/**
 * Convert a `messageMention` node's string attributes into the shared
 * `<message-ref />` builder input. Empty strings mean "absent" — the node
 * stores every attribute as a string so it round-trips through the DOM.
 */
function buildMessageMentionXml(attrs: Record<string, unknown>): string {
  const parsedIndex = Number.parseInt(stringAttr(attrs, "messageIndex"), 10);
  const rawRole = stringAttr(attrs, "role");
  return buildMessageRefXml({
    projectName: stringAttr(attrs, "projectName"),
    sessionName: stringAttr(attrs, "sessionName") || null,
    conversationId: stringAttr(attrs, "conversationId"),
    conversationName: stringAttr(attrs, "conversationName") || null,
    messageIndex: Number.isNaN(parsedIndex) ? 0 : parsedIndex,
    role: rawRole === "user" || rawRole === "notice" ? rawRole : "assistant",
    timestamp: stringAttr(attrs, "timestamp") || null,
    model: stringAttr(attrs, "model") || null,
    compaction:
      stringAttr(attrs, "compacted") === "true"
        ? {
            artifactId: stringAttr(attrs, "compactArtifactId"),
            createdAt: stringAttr(attrs, "compactCreatedAt"),
          }
        : null,
  });
}

/**
 * Convert a `ticketMention` node's string attributes back into the canonical
 * `<ticket-ref />` tag. Identifier and read command are re-derived from
 * project name and number, so the emitted XML stays canonical regardless of
 * what was pasted.
 */
function buildTicketMentionXml(attrs: Record<string, unknown>): string {
  const parsedNumber = Number.parseInt(stringAttr(attrs, "ticketNumber"), 10);
  return buildTicketRefXml({
    projectName: stringAttr(attrs, "projectName"),
    ticketNumber: Number.isNaN(parsedNumber) ? 0 : parsedNumber,
    title: stringAttr(attrs, "title"),
  });
}

function stringAttr(attrs: Record<string, unknown>, key: string): string {
  const raw = attrs[key];
  return typeof raw === "string" ? raw : "";
}

function specPickerItems(
  query: string,
  context: ReferencePickerContext,
): ReferencePickerItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return context.specs
    .filter((spec) =>
      normalizedQuery.length === 0
        ? true
        : spec.slug.toLowerCase().includes(normalizedQuery) ||
          spec.name.toLowerCase().includes(normalizedQuery),
    )
    .map((spec, inputIndex) => ({ spec, inputIndex }))
    .sort((left, right) => {
      const leftCurrent =
        left.spec.projectName === context.currentProjectName ? 0 : 1;
      const rightCurrent =
        right.spec.projectName === context.currentProjectName ? 0 : 1;
      return leftCurrent - rightCurrent || left.inputIndex - right.inputIndex;
    })
    .map(({ spec }) => ({
      type: "spec",
      id: `spec:${spec.projectName}:${spec.specId}`,
      label: spec.name,
      description: `${spec.slug} · ${spec.projectName}`,
      matchIndices: matchingIndices(spec.name, normalizedQuery),
      attrs: {
        projectName: spec.projectName,
        slug: spec.slug,
        name: spec.name,
        revision: String(spec.revision),
        readCommand: buildSpecReadCommand(spec.projectName, spec.slug),
      },
    }));
}

function specElementPickerItems(
  type: SpecPickerElement["type"],
  query: string,
  context: ReferencePickerContext,
): ReferencePickerItem[] {
  const spec = context.selectedSpec;
  if (!spec) return [];
  const normalizedQuery = query.trim().toLowerCase();
  return spec.elements
    .filter(
      (element) =>
        element.type === type &&
        (normalizedQuery.length === 0 ||
          element.handle.toLowerCase().includes(normalizedQuery) ||
          element.searchText.toLowerCase().includes(normalizedQuery)),
    )
    .map((element) => ({
      type,
      id: `${type}:${spec.projectName}:${spec.specId}:${element.elementId}`,
      label: `${spec.slug}/${element.handle}`,
      description: element.name,
      matchIndices: matchingIndices(element.handle, normalizedQuery).map(
        (index) => spec.slug.length + 1 + index,
      ),
      attrs: {
        projectName: spec.projectName,
        slug: spec.slug,
        handle: element.handle,
        name: element.name,
        revision: String(spec.revision),
        readCommand: buildSpecReadCommand(
          spec.projectName,
          spec.slug,
          element.handle,
        ),
      },
    }));
}

function matchingIndices(value: string, normalizedQuery: string): number[] {
  if (normalizedQuery.length === 0) return [];
  const start = value.toLowerCase().indexOf(normalizedQuery);
  if (start === -1) return [];
  return Array.from(
    { length: normalizedQuery.length },
    (_, index) => start + index,
  );
}

export const REFERENCE_REGISTRY = [
  {
    type: "conversation",
    nodeName: "conversationMention",
    xmlTag: "conversation-ref",
    attrsSchema: conversationRefAttrsSchema,
    buildXml: buildConversationRefXml,
    parseAttrs: (attrs: unknown) => ({
      ...conversationRefAttrsToMentionAttrs(
        conversationRefAttrsSchema.parse(attrs),
      ),
    }),
    EditorChip: ConversationMentionChip,
    TranscriptChip: transcriptChip(
      conversationRefAttrsSchema,
      ConversationLinkChip,
    ),
    pickerSource: {
      groupLabel: "Conversations",
      queryAliases: ["conversation", "conversations"],
      getItems: (query, context) =>
        filterAndScoreConversations(query, context.conversations, {
          currentProjectName: context.currentProjectName,
          currentConversationId: context.currentConversationId,
        }).items.map(({ item, indices }) => ({
          type: "conversation",
          id: `conversation:${item.conversationId}`,
          label: resolveDisplayLabel({
            conversationName: item.conversationName,
            summary: item.summary,
            firstPromptSnippet: item.firstPromptSnippet,
            conversationId: item.conversationId,
          }),
          description: [
            item.projectName,
            conversationTargetScopeLabel(conversationListItemTarget(item)),
          ].join(" · "),
          matchIndices: indices,
          attrs: { ...conversationListItemToMentionAttrs(item) },
        })),
    },
  },
  {
    type: "ticket",
    nodeName: "ticketMention",
    xmlTag: "ticket-ref",
    attrsSchema: ticketRefAttrsSchema,
    buildXml: buildTicketMentionXml,
    parseAttrs: (attrs: unknown) => ({
      ...ticketRefAttrsToMentionAttrs(ticketRefAttrsSchema.parse(attrs)),
    }),
    EditorChip: TicketMentionChip,
    TranscriptChip: transcriptChip(ticketRefAttrsSchema, TicketRefLinkChip),
    pickerSource: {
      groupLabel: "Tickets",
      queryAliases: ["ticket", "tickets"],
      getItems: (query, context) =>
        filterAndScoreTickets(query, context.tickets, {
          currentProjectName: context.currentProjectName,
        }).items.map(({ item }) => {
          const identifier = `${item.projectName}#${item.number}`;
          return {
            type: "ticket",
            id: `ticket:${item.id}`,
            label: identifier,
            description: item.title,
            matchIndices: [],
            attrs: {
              projectName: item.projectName,
              ticketNumber: String(item.number),
              identifier,
              title: item.title,
            },
          };
        }),
    },
  },
  {
    type: "message",
    nodeName: "messageMention",
    xmlTag: "message-ref",
    attrsSchema: messageRefAttrsSchema,
    buildXml: buildMessageMentionXml,
    parseAttrs: (attrs: unknown) => ({
      ...messageRefAttrsToMentionAttrs(messageRefAttrsSchema.parse(attrs)),
    }),
    EditorChip: MessageMentionChip,
    TranscriptChip: transcriptChip(messageRefAttrsSchema, MessageRefLinkChip),
    pickerSource: {
      groupLabel: "Messages",
      queryAliases: ["message", "messages"],
      getItems: () => [],
    },
  },
  {
    type: "spec",
    nodeName: "specMention",
    xmlTag: "spec-ref",
    attrsSchema: specRefAttrsSchema,
    buildXml: (attrs) => buildSpecReferenceXml("spec", attrs),
    parseAttrs: (attrs: unknown) => ({
      ...specRefAttrsToMentionAttrs(specRefAttrsSchema.parse(attrs)),
    }),
    EditorChip: SpecRefEditorChip,
    TranscriptChip: transcriptChip(specRefAttrsSchema, SpecRefTranscriptChip),
    pickerSource: {
      groupLabel: "Specs",
      queryAliases: ["spec", "specs"],
      getItems: specPickerItems,
    },
  },
  {
    type: "requirement",
    nodeName: "requirementMention",
    xmlTag: "requirement-ref",
    attrsSchema: specElementRefAttrsSchema,
    buildXml: (attrs) => buildSpecReferenceXml("requirement", attrs),
    parseAttrs: (attrs: unknown) => ({
      ...specElementRefAttrsToMentionAttrs(
        specElementRefAttrsSchema.parse(attrs),
      ),
    }),
    EditorChip: SpecRefEditorChip,
    TranscriptChip: transcriptChip(
      specElementRefAttrsSchema,
      SpecElementRefTranscriptChip,
    ),
    pickerSource: {
      groupLabel: "Requirements",
      queryAliases: ["requirement", "requirements"],
      getItems: (query, context) =>
        specElementPickerItems("requirement", query, context),
    },
  },
  {
    type: "decision",
    nodeName: "decisionMention",
    xmlTag: "decision-ref",
    attrsSchema: specElementRefAttrsSchema,
    buildXml: (attrs) => buildSpecReferenceXml("decision", attrs),
    parseAttrs: (attrs: unknown) => ({
      ...specElementRefAttrsToMentionAttrs(
        specElementRefAttrsSchema.parse(attrs),
      ),
    }),
    EditorChip: SpecRefEditorChip,
    TranscriptChip: transcriptChip(
      specElementRefAttrsSchema,
      SpecElementRefTranscriptChip,
    ),
    pickerSource: {
      groupLabel: "Decisions",
      queryAliases: ["decision", "decisions"],
      getItems: (query, context) =>
        specElementPickerItems("decision", query, context),
    },
  },
  {
    type: "task",
    nodeName: "taskMention",
    xmlTag: "task-ref",
    attrsSchema: specElementRefAttrsSchema,
    buildXml: (attrs) => buildSpecReferenceXml("task", attrs),
    parseAttrs: (attrs: unknown) => ({
      ...specElementRefAttrsToMentionAttrs(
        specElementRefAttrsSchema.parse(attrs),
      ),
    }),
    EditorChip: SpecRefEditorChip,
    TranscriptChip: transcriptChip(
      specElementRefAttrsSchema,
      SpecElementRefTranscriptChip,
    ),
    pickerSource: {
      groupLabel: "Tasks",
      queryAliases: ["task", "tasks"],
      getItems: (query, context) =>
        specElementPickerItems("task", query, context),
    },
  },
  {
    type: "question",
    nodeName: "questionMention",
    xmlTag: "question-ref",
    attrsSchema: specElementRefAttrsSchema,
    buildXml: (attrs) => buildSpecReferenceXml("question", attrs),
    parseAttrs: (attrs: unknown) => ({
      ...specElementRefAttrsToMentionAttrs(
        specElementRefAttrsSchema.parse(attrs),
      ),
    }),
    EditorChip: SpecRefEditorChip,
    TranscriptChip: transcriptChip(
      specElementRefAttrsSchema,
      SpecElementRefTranscriptChip,
    ),
    pickerSource: {
      groupLabel: "Questions",
      queryAliases: ["question", "questions"],
      getItems: (query, context) =>
        specElementPickerItems("question", query, context),
    },
  },
  {
    type: "assumption",
    nodeName: "assumptionMention",
    xmlTag: "assumption-ref",
    attrsSchema: specElementRefAttrsSchema,
    buildXml: (attrs) => buildSpecReferenceXml("assumption", attrs),
    parseAttrs: (attrs: unknown) => ({
      ...specElementRefAttrsToMentionAttrs(
        specElementRefAttrsSchema.parse(attrs),
      ),
    }),
    EditorChip: SpecRefEditorChip,
    TranscriptChip: transcriptChip(
      specElementRefAttrsSchema,
      SpecElementRefTranscriptChip,
    ),
    pickerSource: {
      groupLabel: "Assumptions",
      queryAliases: ["assumption", "assumptions"],
      getItems: (query, context) =>
        specElementPickerItems("assumption", query, context),
    },
  },
] as const satisfies readonly ReferenceRegistryEntry[];

export function getReferenceByType(
  type: ReferenceType,
): ReferenceRegistryEntry {
  return REFERENCE_REGISTRY.find((entry) => entry.type === type)!;
}

export function getReferenceByNodeName(
  nodeName: string,
): ReferenceRegistryEntry | undefined {
  return REFERENCE_REGISTRY.find((entry) => entry.nodeName === nodeName);
}

export function getReferenceByXmlTag(
  xmlTag: string,
): ReferenceRegistryEntry | undefined {
  return REFERENCE_REGISTRY.find((entry) => entry.xmlTag === xmlTag);
}
