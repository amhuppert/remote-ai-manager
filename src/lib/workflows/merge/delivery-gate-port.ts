import { createDeliveryGateActor } from "./actors";
import type { MergeMachineType } from "./machine";
import type { DeliveryGateEvaluator } from "./types";

export function provideDeliveryGate(
  machine: MergeMachineType,
  evaluator: DeliveryGateEvaluator,
): MergeMachineType {
  return machine.provide({
    actors: { deliveryGate: createDeliveryGateActor(evaluator) },
  });
}
