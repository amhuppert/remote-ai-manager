import { Fragment } from "react";
import { parameterValueEmphasis } from "@/components/model-selection-presentation";
import { findBackendModelDefinition } from "@/lib/agent-backends/catalog";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface ModelSelectionMetadataProps {
  /** Which catalog the persisted ids belong to, for presentation signals. */
  backend: AgentBackendId;
  selection: BackendModelSelection;
}

export default function ModelSelectionMetadata({
  backend,
  selection,
}: ModelSelectionMetadataProps): React.JSX.Element {
  const model = findBackendModelDefinition(backend, selection.modelId);
  const parameters = Object.entries(selection.parameters).sort(
    ([left], [right]) => left.localeCompare(right),
  );

  return (
    <>
      <span className="text-text-secondary">{selection.modelId}</span>
      {parameters.map(([parameterId, value]) => {
        const definition = model?.parameters.find(
          (candidate) => candidate.id === parameterId,
        );
        // A tier the catalog marks as beyond the provider's scale keeps the
        // rainbow treatment it had before the metadata became parameter-generic.
        const emphasized =
          definition !== undefined &&
          parameterValueEmphasis(definition, value) !== undefined;
        return (
          <Fragment key={parameterId}>
            <span className="mx-[5px] text-text-tertiary">&middot;</span>
            <span
              className={emphasized ? "cc-rainbow-text" : "text-text-secondary"}
            >
              {parameterId}={value}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}
