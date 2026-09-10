"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { buildExecutionRefXml } from "@/lib/workflow-graph/references";
import { createClientLogger } from "@/lib/logging/client-logger";

const logger = createClientLogger("references.execution");

export function CopyExecutionReferenceButton(
  props: Parameters<typeof buildExecutionRefXml>[0],
): React.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildExecutionRefXml(props));
      setState("copied");
    } catch {
      setState("failed");
      logger.warn("execution_reference.copy_failed", {
        executionId: props.executionId,
      });
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-xs">
      <Button size="sm" touch onClick={() => void copy()}>
        {state === "copied" ? "Copied" : "Copy reference"}
      </Button>
      {state === "failed" && (
        <span role="status" className="text-[0.7rem] text-red">
          Copy failed. Try again.
        </span>
      )}
    </span>
  );
}
