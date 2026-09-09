/**
 * The two input fingerprints a checkpoint delivery is bound to.
 *
 * `fingerprintAssembledInput` covers what the provider was actually sent: the
 * effective prompt text — seed block, transient context and expanded user
 * text alike — and the image bytes attached to it. Two attempts that reached
 * the provider with different effective inputs therefore never share it.
 *
 * `fingerprintSubmittedInput` covers what the caller SUBMITTED — prompt text,
 * image bytes and the structured feedback carried on the turn — because that
 * is the only form both sides of a later repair can recompute: a queued batch
 * the drain assembled is reassembled from its retained rows by the same
 * function, whereas an assembled prompt that carried transient context blocks
 * could never be rebuilt from durable state. Keys are sorted before hashing so
 * a Zod-parsed copy of the same input fingerprints identically.
 */

import { createHash } from "node:crypto";

import type {
  DocumentFeedbackPayload,
  NotepadFeedbackPayload,
} from "@/lib/conversations/message-content-schemas";

export interface SubmittedInputFingerprintSource {
  promptText: string;
  images: readonly { mediaType: string; base64Data: string }[];
  documentFeedback?: DocumentFeedbackPayload | undefined;
  notepadFeedback?: readonly NotepadFeedbackPayload[] | undefined;
}

export interface AssembledInputFingerprintSource {
  /** The exact prompt text handed to the provider. */
  promptText: string;
  images: readonly { mediaType: string; base64Data: string }[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function imageDigests(
  images: readonly { mediaType: string; base64Data: string }[],
) {
  return images.map((image) => ({
    mediaType: image.mediaType,
    sha256: sha256(image.base64Data),
  }));
}

export function fingerprintSubmittedInput(
  input: SubmittedInputFingerprintSource,
): string {
  const basis = canonical({
    kind: "submitted",
    promptText: input.promptText,
    images: imageDigests(input.images),
    documentFeedback: input.documentFeedback ?? null,
    notepadFeedback: input.notepadFeedback ?? null,
  });
  return `sha256:${sha256(JSON.stringify(basis))}`;
}

export function fingerprintAssembledInput(
  input: AssembledInputFingerprintSource,
): string {
  const basis = canonical({
    kind: "assembled",
    promptText: input.promptText,
    images: imageDigests(input.images),
  });
  return `sha256:${sha256(JSON.stringify(basis))}`;
}
