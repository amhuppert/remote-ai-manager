import type { StatusChipTone } from "@/components/ui/StatusChip";
import type { DeliveryDisplay, SpecPhasePrimary } from "@/lib/specs/phase";

export const phaseLabels: Record<SpecPhasePrimary, string> = {
  abandoned: "Abandoned",
  executing: "Executing",
  in_review: "In review",
  draft: "Draft",
  delivered: "Delivered",
  approved: "Approved",
};

export const phaseTones: Record<SpecPhasePrimary, StatusChipTone> = {
  abandoned: "red",
  executing: "cyan",
  in_review: "amber",
  draft: "neutral",
  delivered: "green",
  approved: "green",
};

export function deliveryLabel(delivery: DeliveryDisplay): string {
  if (delivery.allWaived) return "All delivery waived";
  if (delivery.totalInScope === 0) return "No delivery scope";
  return `${delivery.provenCount}/${delivery.totalInScope} delivered`;
}

export function deliveryTone(delivery: DeliveryDisplay): StatusChipTone {
  if (delivery.allWaived) return "amber";
  if (delivery.totalInScope === 0) return "neutral";
  return delivery.provenCount === delivery.totalInScope ? "green" : "cyan";
}
