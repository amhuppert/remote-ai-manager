// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { ConversationMentionNode } from "./conversation-mention-node";
import { deserializePromptDoc } from "./deserializer";
import { MessageMentionNode } from "./message-mention-node";
import { REFERENCE_REGISTRY } from "./reference-registry";
import { serializePromptDoc } from "./serializer";
import {
  AssumptionMentionNode,
  DecisionMentionNode,
  QuestionMentionNode,
  RequirementMentionNode,
  SpecMentionNode,
  TaskMentionNode,
} from "./spec-mention-nodes";
import { TicketMentionNode } from "./ticket-mention-node";

const REFERENCE_FIXTURES = [
  {
    type: "conversation",
    nodeName: "conversationMention",
    xml: '<conversation-ref project-name="my-app" project-path="/repos/my-app" scope="session" session-name="main" worktree-path="/repos/my-app/.worktrees/main" conversation-id="conv-123" conversation-name="Refactor parser" backend="claude" backend-ref="claude-sess-abc" debug-log-path="" status="running" last-activity-at="2024-06-01T12:00:00Z" compact-status="none" read-command="cctl conversation read conv-123 --outline" />',
  },
  {
    type: "message",
    nodeName: "messageMention",
    xml: '<message-ref project-name="my-app" session-name="main" conversation-id="conv-123" conversation-name="Refactor parser" message-index="5" role="assistant" timestamp="2026-07-06T12:00:00Z" model="opus" compacted="true" compact-artifact-id="art-1" compact-created-at="2026-07-05T10:30:00Z" compaction-command="cctl conversation compaction get conv-123 --message 5 --json" read-command="cctl conversation read conv-123 --message 5" />',
  },
  {
    type: "ticket",
    nodeName: "ticketMention",
    xml: '<ticket-ref project-name="command-center" ticket-number="12" identifier="command-center#12" title="Add durable ticket context" read-command="cctl ticket get &apos;command-center#12&apos;" />',
  },
  {
    type: "spec",
    nodeName: "specMention",
    xml: '<spec-ref project-name="command-center" slug="native-sdd" name="Native SDD" revision="3" read-command="cctl spec show &apos;native-sdd&apos; --project &apos;command-center&apos;" />',
  },
  {
    type: "requirement",
    nodeName: "requirementMention",
    xml: '<requirement-ref project-name="command-center" slug="native-sdd" handle="R5" name="Unified references" revision="3" read-command="cctl spec get &apos;native-sdd/R5&apos; --project &apos;command-center&apos;" />',
  },
  {
    type: "decision",
    nodeName: "decisionMention",
    xml: '<decision-ref project-name="command-center" slug="native-sdd" handle="D2" name="Immutable revisions" revision="3" read-command="cctl spec get &apos;native-sdd/D2&apos; --project &apos;command-center&apos;" />',
  },
  {
    type: "task",
    nodeName: "taskMention",
    xml: '<task-ref project-name="command-center" slug="native-sdd" handle="T15" name="Unified picker" revision="3" read-command="cctl spec get &apos;native-sdd/T15&apos; --project &apos;command-center&apos;" />',
  },
  {
    type: "question",
    nodeName: "questionMention",
    xml: '<question-ref project-name="command-center" slug="native-sdd" handle="Q2" name="Which retention period applies?" revision="3" read-command="cctl spec get &apos;native-sdd/Q2&apos; --project &apos;command-center&apos;" />',
  },
  {
    type: "assumption",
    nodeName: "assumptionMention",
    xml: '<assumption-ref project-name="command-center" slug="native-sdd" handle="A1" name="SQLite remains authoritative" revision="3" read-command="cctl spec get &apos;native-sdd/A1&apos; --project &apos;command-center&apos;" />',
  },
] as const;

function roundTrip(xml: string): {
  prompt: string;
  nodeName: string | undefined;
} {
  const editor = new Editor({
    extensions: [
      StarterKit,
      ConversationMentionNode,
      MessageMentionNode,
      TicketMentionNode,
      SpecMentionNode,
      RequirementMentionNode,
      DecisionMentionNode,
      TaskMentionNode,
      QuestionMentionNode,
      AssumptionMentionNode,
    ],
    content: deserializePromptDoc({ prompt: xml, images: [] }),
  });

  const prompt = serializePromptDoc({
    doc: editor.state.doc,
    attachments: [],
  }).prompt;
  const nodeName = editor.state.doc.firstChild?.firstChild?.type.name;
  editor.destroy();
  return { prompt, nodeName };
}

describe("existing reference serialization/parser parity", () => {
  for (const fixture of REFERENCE_FIXTURES) {
    it(`round-trips the pinned ${fixture.type} reference fixture unchanged`, () => {
      expect(roundTrip(fixture.xml)).toEqual({
        prompt: fixture.xml,
        nodeName: fixture.nodeName,
      });
    });
  }

  it("registers every existing reference type with the complete contract", () => {
    expect(
      REFERENCE_REGISTRY.map((entry) => ({
        type: entry.type,
        nodeName: entry.nodeName,
        xmlTag: entry.xmlTag,
        hasAttrsSchema: typeof entry.attrsSchema.safeParse === "function",
        hasBuildXml: typeof entry.buildXml === "function",
        hasParseAttrs: typeof entry.parseAttrs === "function",
        hasEditorChip: typeof entry.EditorChip === "function",
        hasTranscriptChip: typeof entry.TranscriptChip === "function",
        hasPickerSource: entry.pickerSource !== undefined,
      })),
    ).toEqual([
      {
        type: "conversation",
        nodeName: "conversationMention",
        xmlTag: "conversation-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "ticket",
        nodeName: "ticketMention",
        xmlTag: "ticket-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "message",
        nodeName: "messageMention",
        xmlTag: "message-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "spec",
        nodeName: "specMention",
        xmlTag: "spec-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "requirement",
        nodeName: "requirementMention",
        xmlTag: "requirement-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "decision",
        nodeName: "decisionMention",
        xmlTag: "decision-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "task",
        nodeName: "taskMention",
        xmlTag: "task-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "question",
        nodeName: "questionMention",
        xmlTag: "question-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
      {
        type: "assumption",
        nodeName: "assumptionMention",
        xmlTag: "assumption-ref",
        hasAttrsSchema: true,
        hasBuildXml: true,
        hasParseAttrs: true,
        hasEditorChip: true,
        hasTranscriptChip: true,
        hasPickerSource: true,
      },
    ]);
  });
});
