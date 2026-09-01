import { stableStringify } from "@/lib/state-store/serialization";
import type { DeliveryPlanDocument } from "./delivery-plan";
import {
  deliveryPlanDocumentDiffSchema,
  type DeliveryPlanDocumentDiff,
} from "./delivery-plan-views";

export { deliveryPlanDocumentDiffSchema, type DeliveryPlanDocumentDiff };

export function deliveryPlanDocumentDiff(
  base: DeliveryPlanDocument,
  target: DeliveryPlanDocument,
): DeliveryPlanDocumentDiff {
  return deliveryPlanDocumentDiffSchema.parse({
    launchChanged: false,
    bindingChanged:
      stableStringify(base.binding) !== stableStringify(target.binding),
  });
}
