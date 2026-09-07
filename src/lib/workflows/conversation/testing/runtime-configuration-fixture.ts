import type { DesiredRuntimeConfiguration } from "../pre-turn/runtime-recreate";
import {
  CC_CONTEXT,
  CC_CLI_INSTRUCTIONS,
  selectAskQuestionInstructions,
} from "@/lib/prompt/sdk-driver";
import { MEMORY_ADVISORY_CONTRACT } from "@/lib/memory/advisory-contract";

export function runtimeConfigurationFixture(
  overrides: Partial<DesiredRuntimeConfiguration> = {},
): DesiredRuntimeConfiguration {
  return {
    backend: "claude",
    modelSelection: { modelId: "opus", parameters: { effort: "high" } },
    alignmentVersion: null,
    repeatableInstructions: [
      CC_CONTEXT,
      selectAskQuestionInstructions(undefined),
      CC_CLI_INSTRUCTIONS,
      MEMORY_ADVISORY_CONTRACT,
    ],
    instructionSelection: { autonomous: false },
    ...overrides,
  };
}
