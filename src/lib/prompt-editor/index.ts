export { ImageMarker } from "./image-marker-node";
export type { ImageMarkerAttrs, ImageMarkerStorage } from "./image-marker-node";
export { SlashCommandMarker } from "./slash-command-marker-node";
export type {
  SlashCommandKind,
  SlashCommandMarkerAttrs,
  SlashCommandTriggerChar,
} from "./slash-command-marker-node";
export { FileMentionNode } from "./file-mention-node";
export type { FileMentionAttrs } from "./file-mention-node";
export {
  ConversationMentionNode,
  conversationRefAttrsToMentionAttrs,
} from "./conversation-mention-node";
export type { ConversationMentionAttrs } from "./conversation-mention-node";
export {
  MessageMentionNode,
  messageRefAttrsToMentionAttrs,
} from "./message-mention-node";
export type { MessageMentionAttrs } from "./message-mention-node";
export {
  TicketMentionNode,
  ticketRefAttrsToMentionAttrs,
} from "./ticket-mention-node";
export type { TicketMentionAttrs } from "./ticket-mention-node";
export {
  AssumptionMentionNode,
  DecisionMentionNode,
  QuestionMentionNode,
  RequirementMentionNode,
  SpecMentionNode,
  TaskMentionNode,
  buildSpecReadCommand,
  buildSpecReferenceXml,
  specElementRefAttrsSchema,
  specElementRefAttrsToMentionAttrs,
  specRefAttrsSchema,
  specRefAttrsToMentionAttrs,
} from "./spec-mention-nodes";
export type {
  SpecElementMentionAttrs,
  SpecElementRefAttrs,
  SpecMentionAttrs,
  SpecRefAttrs,
  SpecReferenceType,
} from "./spec-mention-nodes";
export { RefPasteHandler } from "./ref-paste-extension";
export { ArgumentHint } from "./argument-hint-extension";
export { serializePromptDoc } from "./serializer";
export type { SerializedPromptDoc } from "./serializer";
export { deserializePromptDoc } from "./deserializer";
export { ImagePasteHandler } from "./paste-handler-extension";
export { SlashCommand } from "./slash-command-extension";
export type { SlashCommandTrigger } from "./slash-command-extension";
export {
  ReferencePicker,
  REFERENCE_PICKER_TRIGGERS,
} from "./reference-picker-extension";
export type {
  ReferencePickerExtensionOptions,
  ReferencePickerSuggestion,
} from "./reference-picker-extension";
export {
  buildPickerView,
  parseSpecDrillInQuery,
  pickerHasAnyMatch,
  scopeForTrigger,
  PICKER_ELEMENT_ORDER,
  PICKER_KIND_ORDER,
  PICKER_SCOPE_CYCLE,
  PICKER_SECTION_CAP,
} from "./reference-picker";
export type {
  PickerDrillScope,
  PickerGlyph,
  PickerItemRow,
  PickerMoreRow,
  PickerRow,
  PickerScope,
  PickerSection,
  PickerSelection,
  PickerTab,
  PickerTrigger,
  PickerView,
  PickerViewInput,
} from "./reference-picker";
export { TerminalHotkeys } from "./terminal-hotkeys-extension";
export {
  REFERENCE_REGISTRY,
  getReferenceByNodeName,
  getReferenceByType,
  getReferenceByXmlTag,
} from "./reference-registry";
export type {
  ReferenceItemFact,
  ReferenceItemMeta,
  ReferenceItemPresentation,
  ReferenceNodeName,
  ReferencePickerContext,
  ReferencePickerItem,
  ReferencePickerSource,
  ReferenceRegistryEntry,
  ReferenceStatusTone,
  SpecPickerElement,
  SpecPickerSpec,
  ReferenceType,
  ReferenceXmlTag,
} from "./reference-registry";
export { CodeFormatting } from "./code-formatting-extension";
