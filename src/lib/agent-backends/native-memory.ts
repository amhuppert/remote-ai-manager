/**
 * Native provider memory: what Command Center does about the memory system the
 * backend ships with (spec `memory` R14).
 *
 * Command Center's memory library is a REPLACEMENT, not a second opinion, so
 * every registered backend has to say which of two states it is in — and the
 * declaration is required on the descriptor for the same reason `managedSkills`
 * is: a backend must not be registrable without deciding. The states are
 * deliberately only two, because "we asked it nicely not to" is not one of
 * them:
 *
 *  - `disabled` claims the ADAPTER turns the provider's memory off in every
 *    environment Command Center launches, naming the `lever` it uses. A
 *    backend making this claim is proven by its own launched-configuration
 *    test; the claim is what those tests are about.
 *  - `none` is the honest admission that the SDK surface exposes no such lever.
 *    It is not a waiver: it is what the two disclosure surfaces render, so the
 *    operator knows that backend is running two memory systems at once.
 *
 * The type lives here rather than beside either provider because both the
 * client-safe catalog and the server registry project it, and the disclosure
 * derivation below is the one place either surface computes what to say.
 */

import { z } from "zod";

import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";

export const backendNativeMemorySchema = z.discriminatedUnion("mechanism", [
  z.object({
    mechanism: z.literal("disabled"),
    /** The lever the adapter pulls, in provider terms, for the audit trail. */
    lever: z.string().min(1),
  }),
  z.object({
    mechanism: z.literal("none"),
    /** What was inspected, and what it did not expose. Rendered to humans. */
    reason: z.string().min(1),
  }),
]);
export type BackendNativeMemory = z.infer<typeof backendNativeMemorySchema>;

/** One backend that keeps its own memory running, and why. */
export const nativeMemoryExceptionSchema = z.object({
  backend: agentBackendSchema,
  label: z.string(),
  reason: z.string(),
});
export type NativeMemoryException = z.infer<typeof nativeMemoryExceptionSchema>;

/** The minimum a caller needs to hand over: catalog entries and descriptors both fit. */
export interface NativeMemoryDeclarant {
  readonly id: AgentBackendId;
  readonly label: string;
  readonly nativeMemory: BackendNativeMemory;
}

/**
 * The backends with no disable mechanism, in the caller's order. An empty
 * result is the ordinary case and means the disclosure surfaces render nothing
 * — a backend that IS neutralized must not produce a notice, or the notice
 * stops meaning anything.
 */
export function listNativeMemoryExceptions(
  declarants: readonly NativeMemoryDeclarant[],
): readonly NativeMemoryException[] {
  return declarants.flatMap((declarant) =>
    declarant.nativeMemory.mechanism === "none"
      ? [
          {
            backend: declarant.id,
            label: declarant.label,
            reason: declarant.nativeMemory.reason,
          },
        ]
      : [],
  );
}

/**
 * The one-line disclosure for a header — the `cctl memory index` header today,
 * and the sentence the Memory Library's notice reuses.
 *
 * Null, not an empty string, when there is nothing to disclose: the caller has
 * to decide whether to render a line at all, and a blank line in a byte-counted
 * header is not the same as no line. The wording says what the operator can act
 * on — which backend, and why it could not be turned off — rather than
 * apologising for it.
 */
export function renderNativeMemoryDisclosureLine(
  exceptions: readonly NativeMemoryException[],
): string | null {
  if (exceptions.length === 0) return null;
  const named = exceptions
    .map((exception) => `${exception.label} (${exception.reason})`)
    .join("; ");
  return `native memory still running: ${named}`;
}
