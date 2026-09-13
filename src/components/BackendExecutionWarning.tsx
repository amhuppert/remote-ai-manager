"use client";

import { AlertTriangleIcon } from "@/components/icons";
import { useBackendCatalogEntry } from "@/lib/agent-backends/queries";
import type { AgentBackendId } from "@/lib/shared/schemas";

export default function BackendExecutionWarning({
  backend,
}: {
  backend: AgentBackendId;
}) {
  const entry = useBackendCatalogEntry(backend);
  if (!entry) return null;
  const instructionOnly =
    entry.execution.conversation?.fsWriteRestriction === "instruction-only" ||
    entry.execution.tasks?.fsWriteRestriction === "instruction-only";
  const warnings = entry.executionWarnings ?? [];
  if (!instructionOnly && warnings.length === 0) return null;

  return (
    <p
      role="note"
      className="m-0 flex items-start gap-sm rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm text-xs leading-relaxed text-text-secondary"
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-amber">
        <AlertTriangleIcon size={14} />
      </span>
      <span>
        <strong className="font-medium text-amber">
          {entry.label} execution limits.
        </strong>{" "}
        {instructionOnly && (
          <>
            Read-only and file ownership limits rely on instructions.{" "}
            {entry.label} may edit outside its assigned paths.{" "}
          </>
        )}
        {warnings.join(" ")}
      </span>
    </p>
  );
}
