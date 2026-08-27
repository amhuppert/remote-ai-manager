/**
 * Detect and parse the inline self-closing reference tags emitted by the
 * prompt-editor serializer for every type in the reference registry.
 *
 * The registry-free tag scanning lives in `ref-tags`; this module adds the
 * registry-aware lookups on top. Import `ref-tags` directly from server-only
 * code — reaching the registry from a route drags React chips and Tiptap nodes
 * into its module graph.
 */

import {
  REFERENCE_REGISTRY,
  getReferenceByType,
  type ReferenceType,
  type ReferenceXmlTag,
} from "@/lib/prompt-editor/reference-registry";
import { findRefTags, type FoundRef } from "./ref-tags";

export { findRefTags, parseRefAttrs, type FoundRef } from "./ref-tags";

export interface FoundRegisteredRef extends FoundRef {
  type: ReferenceType;
  xmlTag: ReferenceXmlTag;
}

export function findConversationRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("conversation").xmlTag);
}

export function findMessageRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("message").xmlTag);
}

export function findTicketRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("ticket").xmlTag);
}

export function findSpecRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("spec").xmlTag);
}

export function findRequirementRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("requirement").xmlTag);
}

export function findDecisionRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("decision").xmlTag);
}

export function findTaskRefs(text: string): FoundRef[] {
  return findRefTags(text, getReferenceByType("task").xmlTag);
}

export function findRegisteredRefs(text: string): FoundRegisteredRef[] {
  return REFERENCE_REGISTRY.flatMap((entry) =>
    findRefTags(text, entry.xmlTag).map((ref) => ({
      ...ref,
      type: entry.type,
      xmlTag: entry.xmlTag,
    })),
  ).sort((a, b) => a.start - b.start);
}
