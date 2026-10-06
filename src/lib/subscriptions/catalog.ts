import { graphWorkflowBoundaryKindSchema } from "@/lib/workflow-graph/event-schemas";
import {
  specSseEventTypeSchema,
  specReviewEventTypeSchema,
  specAuthoringEventTypeSchema,
  specDeliveryPlanEventTypeSchema,
} from "@/lib/specs/schemas";
import { runBoundaryKindSchema } from "@/lib/runs/schemas";
import type { SubscriptionSourceRef } from "./schemas";
import { subscriptionCatalogSchema } from "./controls-schemas";

const events = (ids: readonly string[]) =>
  ids.map((id) => ({
    id,
    label: id
      .replace(/^(spec-|graph-workflow-boundary:|run-boundary:)/, "")
      .replaceAll(/[-_]/g, " "),
  }));

export const subscriptionCatalog = subscriptionCatalogSchema.parse({
  sources: [
    {
      kind: "notepad",
      label: "Notepad",
      description:
        "Content revisions and newly added open review comments. Comment resolution and deletion do not request work.",
      identityDescription: "Notepad ID",
      allowedModes: ["passive"],
      eventKinds: events(["notepad-content-revised", "notepad-comment-added"]),
    },
    {
      kind: "ticket",
      label: "Ticket",
      description: "Status transitions and posted status updates.",
      identityDescription: "Ticket UUID (from ticket get)",
      allowedModes: ["passive"],
      eventKinds: events(["ticket-status-changed", "ticket-status-posted"]),
    },
    {
      kind: "spec",
      label: "Native SDD spec",
      description:
        "Revision, review, approval, evidence and delivery-plan changes.",
      identityDescription: "Spec ID (from spec get)",
      allowedModes: ["passive"],
      eventKinds: events([
        ...specSseEventTypeSchema.options,
        ...specReviewEventTypeSchema.options,
        ...specAuthoringEventTypeSchema.options,
        ...specDeliveryPlanEventTypeSchema.options,
      ]),
    },
    {
      kind: "workflow",
      label: "Workflow",
      description:
        "Follow recorded boundaries or wake once when an execution ends.",
      identityDescription: "Execution ID",
      allowedModes: ["passive", "active"],
      eventKinds: events(
        graphWorkflowBoundaryKindSchema.options.map(
          (kind) => `graph-workflow-boundary:${kind}`,
        ),
      ),
    },
    {
      kind: "run",
      label: "Run",
      description:
        "Boundaries of a supervised agent or workflow run: questions, halts, approvals and its result. Its owner follows it with wake from launch.",
      identityDescription: "Run ID (from run show)",
      allowedModes: ["passive"],
      eventKinds: events(
        runBoundaryKindSchema.options.map((kind) => `run-boundary:${kind}`),
      ),
    },
    {
      kind: "validation",
      label: "Validation",
      description: "The recorded outcome of a validation run.",
      identityDescription: "Validation run ID",
      allowedModes: ["passive", "active"],
      eventKinds: events(["validation-completed"]),
    },
    {
      kind: "git_job",
      label: "Git job",
      description: "The recorded outcome of a background git operation.",
      identityDescription: "Git job ID",
      allowedModes: ["passive", "active"],
      eventKinds: events(["git-job-outcome"]),
    },
  ],
});

export function validateSubscriptionSelection(
  kind: SubscriptionSourceRef["kind"],
  mode: "passive" | "active",
  eventKinds: string[] | null,
): string | null {
  if (kind === "conversation")
    return mode === "passive"
      ? null
      : "Conversation notices support passive subscriptions only.";
  const source = subscriptionCatalog.sources.find(
    (entry) => entry.kind === kind,
  );
  if (!source?.allowedModes.includes(mode))
    return "This source supports passive subscriptions only.";
  if (mode === "active" && eventKinds !== null)
    return "Active waits observe a terminal outcome; event filters apply to passive subscriptions only.";
  if (
    eventKinds?.some(
      (event) => !source.eventKinds.some((allowed) => allowed.id === event),
    )
  )
    return "An event selection is not supported for this source. Read the subscription catalog for allowed events.";
  return null;
}
