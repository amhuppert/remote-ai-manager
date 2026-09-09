/**
 * Lifting the release gate for the run that is trying to earn it.
 *
 * Descriptor `checkpoint` is a release decision (D9): it stays false until
 * this probe passes for that adapter. But admission refuses
 * `backend_unsupported` while it is false, so the probe could never produce
 * the evidence the flag is waiting on. This module turns the flag on for the
 * probe process and nothing else.
 *
 * The catalog hands back the very object the descriptor embeds, so setting
 * the flag here reaches every reader — admission, the descriptor, the
 * capability metadata — without re-registering an adapter or substituting a
 * manager seam. Nothing about the provider path changes; what changes is that
 * the feature is allowed to address it.
 *
 * The result is carried into the run's evidence, so a report can never read
 * as if a shipped capability had been certified when it was the probe that
 * turned it on.
 */

import { conversationCapabilitiesForBackend } from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface ProbeCapabilityState {
  /** What the committed descriptor claims. */
  shipped: boolean;
  /** Whether this run had to turn the capability on to proceed. */
  overridden: boolean;
}

export function enableCheckpointCapabilityForProbe(
  backend: AgentBackendId,
): ProbeCapabilityState {
  const capabilities = conversationCapabilitiesForBackend(backend);
  const shipped = capabilities.checkpoint;
  if (!shipped) capabilities.checkpoint = true;
  return { shipped, overridden: !shipped };
}
