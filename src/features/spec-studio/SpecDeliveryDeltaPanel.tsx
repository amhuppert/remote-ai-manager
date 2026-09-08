"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { useSpecDeltaQuery, type SpecDetailView } from "@/lib/specs/queries";
import { cn } from "@/lib/ui/cn";
import SpecDeliveryScope from "./SpecDeliveryScope";

/**
 * The delivery delta on the execution surface: what the last delivery no
 * longer covers, read from the same server projection `cctl spec delta`
 * renders. The panel computes no classification of its own — a second
 * derivation here is exactly how a Studio counter drifts from gate truth.
 */

export default function SpecDeliveryDeltaPanel({
  detail,
  projectName,
  slug,
  sinceExecutionId,
  plan,
}: {
  detail: SpecDetailView;
  projectName: string;
  slug: string;
  sinceExecutionId?: string;
  plan?: ReactNode;
}): React.JSX.Element {
  const query = useSpecDeltaQuery(projectName, slug, sinceExecutionId);
  return (
    <div
      className={cn(
        "grid min-w-0 gap-xl",
        plan && "grid-cols-2 max-1180:grid-cols-1",
      )}
    >
      {plan}
      {query.isPending ? (
        <p
          role="status"
          className="m-0 font-mono text-[0.78rem] text-text-secondary"
        >
          Reading delivery coverage…
        </p>
      ) : query.isError || query.data === undefined ? (
        <div
          role="alert"
          className="grid gap-sm rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl"
        >
          <p className="m-0 font-mono text-[0.78rem] text-text-primary">
            The delivery delta could not be read.
          </p>
          <Button
            size="sm"
            touch
            loading={query.isFetching}
            layoutClassName="justify-self-start"
            onClick={() => void query.refetch()}
          >
            Retry delivery coverage
          </Button>
        </div>
      ) : (
        <SpecDeliveryScope
          detail={detail}
          projectName={projectName}
          projection={query.data}
          besidePlan={Boolean(plan)}
        />
      )}
    </div>
  );
}
