"use client";

import { useState } from "react";
import { z } from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/AlertDialog";
import { Button } from "@/components/ui/Button";
import {
  FormError,
  FormGroup,
  FormHint,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import { RadioGroup, RadioGroupOption } from "@/components/ui/RadioGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import { specSlugSchema } from "@/lib/specs/handles";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import {
  policyChangeRequiresHardConfirmation,
  resolveDial,
} from "@/lib/specs/policy";
import type { SpecDetailView } from "@/lib/specs/queries";
import {
  specAliasSchema,
  specGatePolicySchema,
  specSchema,
  type SpecGate,
  type SpecGateDial,
  type SpecGatePolicy,
  type SpecGatePreset,
} from "@/lib/specs/schemas";
import {
  specPolicyChangeResultSchema,
  type SpecGateAdmissionView,
} from "@/lib/specs/view-schemas";

import { gateLabels } from "./presentation";
import {
  openDraftForPolicyImpact,
  PolicyImpactPreview,
  type PolicyImpactDraft,
} from "./SpecPolicyImpact";
import SpecReadOnlyNotice from "./SpecReadOnlyNotice";

const logger = createClientLogger("spec-studio-controls");

const ACTIVE_GATES = [
  "requirements",
  "design",
  "execution_start",
  "delivery",
] as const satisfies readonly SpecGate[];

const presetLabels: Record<SpecGatePreset, string> = {
  "contract-bearing": "Contract-bearing",
  exploratory: "Exploratory",
  "fast-path": "Fast path",
};

const presetDescriptions: Record<SpecGatePreset, string> = {
  "contract-bearing": "Human review for authoring, launch, and delivery.",
  exploratory: "Notify while authoring; preserve the delivery gate.",
  "fast-path": "One combined approval for Requirements and Design.",
};

const gateDescriptions: Record<(typeof ACTIVE_GATES)[number], string> = {
  requirements: "Admits the requirements contract.",
  design: "Admits the design narrative and decisions.",
  execution_start: "Admits the approved delivery candidate for launch.",
  delivery: "Admits delivery claims and merge readiness.",
};

type GateSelection = SpecGateDial | "inherit";

export const renameSpecResultSchema = z
  .object({ spec: specSchema, alias: specAliasSchema })
  .strict();
export type RenameSpecResultView = z.infer<typeof renameSpecResultSchema>;

function policyWithSelection(
  current: SpecGatePolicy,
  preset: SpecGatePreset,
  selections: Partial<Record<SpecGate, GateSelection>>,
): SpecGatePolicy {
  const overrides = Object.fromEntries(
    Object.entries(selections).flatMap(([gate, dial]) =>
      dial === undefined || dial === "inherit" ? [] : [[gate, dial]],
    ),
  );
  return specGatePolicySchema.parse({
    ...current,
    preset,
    overrides: Object.keys(overrides).length === 0 ? undefined : overrides,
  });
}

export function PolicyDialog({
  currentPolicy,
  pending,
  error,
  onChangePolicy,
  openDraft,
}: {
  currentPolicy: SpecGatePolicy;
  pending: boolean;
  error: string | null;
  onChangePolicy(input: {
    proposedPolicy: SpecGatePolicy;
    hardConfirmed: boolean;
  }): void;
  openDraft?: PolicyImpactDraft | null;
}): React.JSX.Element {
  const [preset, setPreset] = useState(currentPolicy.preset);
  const [selections, setSelections] = useState<
    Partial<Record<SpecGate, GateSelection>>
  >(() =>
    Object.fromEntries(
      ACTIVE_GATES.map((gate) => [
        gate,
        currentPolicy.overrides?.[gate] ?? "inherit",
      ]),
    ),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);

  const proposedPolicy = policyWithSelection(currentPolicy, preset, selections);
  const changed =
    JSON.stringify(proposedPolicy) !== JSON.stringify(currentPolicy);
  const hardConfirmation = policyChangeRequiresHardConfirmation(
    currentPolicy,
    proposedPolicy,
  );

  return (
    <section
      aria-labelledby="gate-policy-heading"
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
    >
      <h2
        id="gate-policy-heading"
        className="m-0 font-display text-[0.95rem] font-bold text-text-primary"
      >
        Gate policy
      </h2>
      <p className="mt-xs mb-md font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
        Choose the default, then override only gates that deliberately differ.
      </p>

      <RadioGroup
        value={preset}
        onValueChange={(value) => setPreset(value as SpecGatePreset)}
        aria-label="Gate policy preset"
      >
        {(Object.keys(presetLabels) as SpecGatePreset[]).map((value) => (
          <RadioGroupOption
            key={value}
            value={value}
            label={presetLabels[value]}
            description={presetDescriptions[value]}
          />
        ))}
      </RadioGroup>

      <div className="mt-xl grid grid-cols-2 gap-lg max-768:grid-cols-1">
        {ACTIVE_GATES.map((gate) => (
          <FormGroup key={gate}>
            <FormLabel htmlFor={`gate-policy-${gate}`}>
              {gateLabels[gate]}
            </FormLabel>
            <FormHint>{gateDescriptions[gate]}</FormHint>
            {gate === "delivery" && (
              <FormHint>Delivery can never be Off.</FormHint>
            )}
            <Select
              value={selections[gate] ?? "inherit"}
              onValueChange={(value) =>
                setSelections((current) => ({
                  ...current,
                  [gate]: value as GateSelection,
                }))
              }
            >
              <SelectTrigger
                id={`gate-policy-${gate}`}
                layoutClassName="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">
                  Inherit (
                  {resolveDial(
                    { ...proposedPolicy, overrides: undefined },
                    gate,
                  )}
                  )
                </SelectItem>
                <SelectItem value="gate">Gate</SelectItem>
                <SelectItem value="notify">Notify</SelectItem>
                <SelectItem value="off" disabled={gate === "delivery"}>
                  Off
                </SelectItem>
              </SelectContent>
            </Select>
          </FormGroup>
        ))}
      </div>

      {openDraft && (
        <div className="mt-md">
          <PolicyImpactPreview
            draft={openDraft}
            currentPolicy={currentPolicy}
            proposedPolicy={proposedPolicy}
          />
        </div>
      )}
      {error && <FormError role="alert">{error}</FormError>}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!changed || pending}
          >
            Review policy change
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm gate policy change</AlertDialogTitle>
          <AlertDialogDescription>
            {hardConfirmation
              ? "This change loosens at least one gate. Existing approvals are not manufactured and the open authoring stage does not move."
              : "The confirmed policy governs future transitions. Existing approvals and the open authoring stage do not change."}
          </AlertDialogDescription>
          <AlertDialogActions>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                onChangePolicy({
                  proposedPolicy,
                  hardConfirmed: hardConfirmation,
                })
              }
            >
              Confirm policy change
            </AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function PolicyAdmissionNotices({
  admissions,
}: {
  admissions: readonly SpecGateAdmissionView[];
}): React.JSX.Element | null {
  const policyAdmissions = admissions.filter(
    (admission) =>
      admission.basis === "notify_policy" || admission.basis === "off_policy",
  );
  if (policyAdmissions.length === 0) return null;
  return (
    <section
      aria-label="Policy-admitted gates"
      className="mb-lg rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
    >
      <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
        Policy-admitted gates
      </h2>
      <ul className="m-0 mt-md grid list-none gap-sm p-0">
        {policyAdmissions.map((admission) => (
          <li key={admission.id} className="flex flex-wrap items-center gap-md">
            <StatusChip
              tone={admission.basis === "notify_policy" ? "amber" : "neutral"}
            >
              {admission.basis === "notify_policy"
                ? "Proceeded under Notify"
                : "Proceeded with gate off"}
            </StatusChip>
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              {gateLabels[admission.gate]} · revision{" "}
              {admission.revisionId ?? "n/a"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RenameSpecControl({
  currentSlug,
  currentName,
  pending,
  error,
  onRename,
}: {
  currentSlug: string;
  currentName: string;
  pending: boolean;
  error: string | null;
  onRename(input: { slug: string; name?: string }): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(currentSlug);
  const [name, setName] = useState(currentName);
  return editing ? (
    <form
      className="grid gap-sm"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = specSlugSchema.safeParse(slug);
        if (!parsed.success || name.trim().length === 0) return;
        onRename({ slug: parsed.data, name: name.trim() });
      }}
    >
      <FormLabel htmlFor="spec-name">Name</FormLabel>
      <FormInput
        id="spec-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <FormLabel htmlFor="spec-slug">Slug</FormLabel>
      <FormInput
        id="spec-slug"
        value={slug}
        onChange={(event) => setSlug(event.target.value)}
      />
      {error && <FormError role="alert">{error}</FormError>}
      <div className="flex gap-xs">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          Save identity
        </Button>
        <Button type="button" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  ) : (
    <div className="flex items-center justify-between gap-md">
      <div>
        <h2 className="m-0 font-display text-[0.95rem] font-bold text-text-primary">
          Identity
        </h2>
        <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
          {currentName} · {currentSlug}
        </p>
      </div>
      <Button type="button" size="sm" onClick={() => setEditing(true)}>
        Edit identity
      </Button>
    </div>
  );
}

function AbandonSpecControl({
  pending,
  error,
  onAbandon,
}: {
  pending: boolean;
  error: string | null;
  onAbandon(reason: string): void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  return (
    <section className="rounded-lg border border-solid border-red-dim bg-red-glow p-lg">
      <h2 className="m-0 font-display text-[0.9rem] font-bold text-red">
        Abandon spec
      </h2>
      <p className="mt-xs mb-md font-mono text-[0.7rem] text-text-secondary">
        This is terminal and preserves the full read-only history.
      </p>
      <FormLabel htmlFor="abandon-spec-reason">Reason</FormLabel>
      <FormInput
        id="abandon-spec-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {error && <FormError role="alert">{error}</FormError>}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={!reason.trim() || pending}
          >
            Abandon spec
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Abandon this spec?</AlertDialogTitle>
          <AlertDialogDescription>
            The spec becomes read-only. Existing definitions and execution
            history remain available.
          </AlertDialogDescription>
          <AlertDialogActions>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onAbandon(reason.trim())}>
              Confirm abandonment
            </AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export default function SpecControlsPanel({
  detail,
  projectName,
}: {
  detail: SpecDetailView;
  projectName: string;
}): React.JSX.Element {
  const rename = useSpecActionMutation<
    { slug: string; name?: string },
    RenameSpecResultView
  >(projectName, detail.spec.slug, "rename", renameSpecResultSchema);
  const abandon = useSpecActionMutation<
    { reason: string },
    z.infer<typeof specSchema>
  >(projectName, detail.spec.slug, "abandon-spec", specSchema);

  if (detail.spec.abandonedAt !== null) {
    return (
      <SpecReadOnlyNotice
        reason={detail.spec.abandonedReason}
        context={`Recorded gate preset: ${presetLabels[detail.spec.gatePolicy.preset]}.`}
      />
    );
  }

  return (
    <div className="grid gap-xl">
      <RenameSpecControl
        currentSlug={detail.spec.slug}
        currentName={detail.spec.name}
        pending={rename.isPending}
        error={rename.error?.message ?? null}
        onRename={(input) =>
          rename.mutate(input, {
            onSuccess: () =>
              logger.info("spec_studio.identity.changed", {
                specId: detail.spec.id,
              }),
          })
        }
      />
      <AbandonSpecControl
        pending={abandon.isPending}
        error={abandon.error?.message ?? null}
        onAbandon={(reason) =>
          abandon.mutate(
            { reason },
            {
              onSuccess: () =>
                logger.info("spec_studio.spec.abandoned", {
                  specId: detail.spec.id,
                }),
            },
          )
        }
      />
    </div>
  );
}

export function SpecGatePolicyPanel({
  detail,
  projectName,
}: {
  detail: SpecDetailView;
  projectName: string;
}): React.JSX.Element {
  const changePolicy = useSpecActionMutation<
    { proposedPolicy: SpecGatePolicy; hardConfirmed: boolean },
    z.infer<typeof specPolicyChangeResultSchema>
  >(
    projectName,
    detail.spec.slug,
    "change-policy",
    specPolicyChangeResultSchema,
  );

  if (detail.spec.abandonedAt !== null) {
    return (
      <SpecReadOnlyNotice
        reason={detail.spec.abandonedReason}
        context={`Recorded gate preset: ${presetLabels[detail.spec.gatePolicy.preset]}.`}
      />
    );
  }
  return (
    <div className="grid gap-xl">
      <PolicyDialog
        key={JSON.stringify(detail.spec.gatePolicy)}
        currentPolicy={detail.spec.gatePolicy}
        pending={changePolicy.isPending}
        error={changePolicy.error?.message ?? null}
        openDraft={openDraftForPolicyImpact(detail)}
        onChangePolicy={(input) =>
          changePolicy.mutate(input, {
            onSuccess: () =>
              logger.info("spec_studio.policy.changed", {
                specId: detail.spec.id,
              }),
          })
        }
      />
      <PolicyAdmissionNotices admissions={detail.gateAdmissions} />
    </div>
  );
}
