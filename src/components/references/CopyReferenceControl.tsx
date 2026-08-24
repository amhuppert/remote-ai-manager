"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  buildSpecReferenceXml,
  type SpecElementMentionAttrs,
  type SpecMentionAttrs,
  type SpecReferenceType,
} from "@/lib/prompt-editor/spec-reference-contract";

const logger = createClientLogger("references.spec");

export interface CopyReferenceControlProps {
  referenceType: SpecReferenceType;
  attrs: SpecMentionAttrs | SpecElementMentionAttrs;
}

export interface CopyReferenceControlDeps {
  writeText(text: string): Promise<void>;
}

export function createCopyReferenceControl(deps: CopyReferenceControlDeps) {
  return function CopyReferenceControl({
    referenceType,
    attrs,
  }: CopyReferenceControlProps): React.JSX.Element {
    const [copied, setCopied] = useState(false);
    const reference = buildSpecReferenceXml(referenceType, { ...attrs });
    const handleCopy = async () => {
      setCopied(false);
      try {
        await deps.writeText(reference);
        setCopied(true);
      } catch {
        logger.warn("copy_reference.failed", { referenceType });
      }
    };
    return (
      <Button
        variant="default"
        size="sm"
        touch
        onClick={() => void handleCopy()}
        aria-label={copied ? "Reference copied" : "Copy reference"}
      >
        {copied ? "Copied" : "Copy reference"}
      </Button>
    );
  };
}

export const CopyReferenceControl = createCopyReferenceControl({
  async writeText(text) {
    await navigator.clipboard.writeText(text);
  },
});
