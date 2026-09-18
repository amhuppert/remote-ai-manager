import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
  listBackends,
} from "@/lib/agent-backends/registry-core";
import {
  createProbeCallLedger,
  type ProbeCallLedger,
} from "../checkpoint-continuation/budget";
import { createSubmissionBudget, type Scenario } from "./evidence";

/** SDK inference retries remain SDK-owned and unavailable unless native evidence reports them. */
export function instrumentHandoffSubmissions(
  scenario: Scenario,
  capture: boolean,
) {
  const budget = createSubmissionBudget(scenario, capture);
  const base = createProbeCallLedger({
    budget:
      scenario === "failures"
        ? { ordinary: 16, compaction: 12 }
        : { ordinary: 12, compaction: 6 },
  });
  const ledger: ProbeCallLedger = {
    ...base,
    admit(kind, label, backend) {
      budget.admit(kind === "compaction" ? "generation" : "ordinary", label);
      return base.admit(kind, label, backend);
    },
  };
  const captureResults: unknown[] = [];
  const descriptors = [...listBackends()];
  _resetBackendRegistryForTesting();
  for (const descriptor of descriptors) {
    const conversation = descriptor.conversation;
    if (!conversation) {
      _registerBackendForTesting(descriptor);
      continue;
    }
    const factory = conversation.factory;
    _registerBackendForTesting({
      ...descriptor,
      conversation: {
        ...conversation,
        factory: {
          ...factory,
          async createRuntime(input) {
            const runtime = await factory.createRuntime(input);
            const original = runtime.captureHandoff?.bind(runtime);
            if (original)
              runtime.captureHandoff = async (request) => {
                budget.admit("capture", request.captureId);
                const result = await original(request);
                captureResults.push(result);
                return result;
              };
            return runtime;
          },
        },
      },
    });
  }
  return { ledger, budget, captureResults };
}
