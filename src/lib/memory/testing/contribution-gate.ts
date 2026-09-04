import type { MemoryContributionGate } from "../delivery-policy";

/**
 * A gate that admits every writer. For tests whose subject is something other
 * than the contribution policy: the policy's own tests drive the real gate
 * over fakes (`delivery-policy.test.ts`) and the service's refusal over a
 * scripted decision (`service.test.ts`).
 */
export function openMemoryContributionGate(): MemoryContributionGate {
  return {
    async decide() {
      return { allowed: true };
    },
  };
}
