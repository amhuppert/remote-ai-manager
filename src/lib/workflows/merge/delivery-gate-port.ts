import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { createDeliveryGateActor } from "./actors";
import type { MergeMachineType } from "./machine";
import type {
  DeliveryGateEvaluateInput,
  DeliveryGateEvaluation,
  DeliveryGateEvaluator,
} from "./types";

const DELIVERY_GATE_PORT_KEY = "__cc_merge_delivery_gate_port" as const;

interface DeliveryGatePortState {
  evaluator: DeliveryGateEvaluator | null;
}

function state(): DeliveryGatePortState {
  return getGlobalSingleton(DELIVERY_GATE_PORT_KEY, () => ({
    evaluator: null,
  }));
}

export function registerDeliveryGateEvaluator(
  evaluator: DeliveryGateEvaluator,
): void {
  state().evaluator = evaluator;
}

export function createRegisteredDeliveryGateEvaluator(): DeliveryGateEvaluator {
  return {
    async evaluate(
      input: DeliveryGateEvaluateInput,
    ): Promise<DeliveryGateEvaluation> {
      const evaluator = state().evaluator;
      if (evaluator === null) {
        throw new Error(
          "Delivery gate evaluator is required for a linked workflow execution",
        );
      }
      return evaluator.evaluate(input);
    },
  };
}

export function provideRegisteredDeliveryGate(
  machine: MergeMachineType,
): MergeMachineType {
  return machine.provide({
    actors: {
      deliveryGate: createDeliveryGateActor(
        createRegisteredDeliveryGateEvaluator(),
      ),
    },
  });
}

export function _resetDeliveryGateEvaluatorForTesting(): void {
  state().evaluator = null;
}
