"use client";

import { useId, useState } from "react";

type CollabAgent = "claude" | "codex";

type CollabAutonomousResolutionThreshold =
  | "none"
  | "minor"
  | "major"
  | "blocking";

export interface CollabConfigRowConfig {
  secondAgent: CollabAgent;
  negotiationRounds: number;
  autonomousResolutionThreshold: CollabAutonomousResolutionThreshold;
}

export interface CollabConfigRowProps {
  config: CollabConfigRowConfig;
  onChange: (next: CollabConfigRowConfig) => void;
  onDismiss: () => void;
  originatingAgent: CollabAgent;
}

const AGENT_LABEL: Record<CollabAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

const NEGOTIATION_ROUNDS_MIN = 1;
const NEGOTIATION_ROUNDS_MAX = 20;

const THRESHOLD_OPTIONS: ReadonlyArray<{
  value: CollabAutonomousResolutionThreshold;
  label: string;
  hint: string;
}> = [
  {
    value: "none",
    label: "none",
    hint: "Always pause when there are conflicts",
  },
  { value: "minor", label: "minor", hint: "Auto-resolve only minor conflicts" },
  {
    value: "major",
    label: "major",
    hint: "Auto-resolve up to major conflicts",
  },
  {
    value: "blocking",
    label: "blocking",
    hint: "Auto-resolve everything, including blocking conflicts",
  },
];

function clampNegotiationRounds(value: number): number {
  if (Number.isNaN(value)) return NEGOTIATION_ROUNDS_MIN;
  if (value < NEGOTIATION_ROUNDS_MIN) return NEGOTIATION_ROUNDS_MIN;
  if (value > NEGOTIATION_ROUNDS_MAX) return NEGOTIATION_ROUNDS_MAX;
  return Math.round(value);
}

export default function CollabConfigRow({
  config,
  onChange,
  onDismiss,
  originatingAgent,
}: CollabConfigRowProps): React.JSX.Element {
  const negotiationRoundsId = useId();
  const thresholdGroupId = useId();

  const [negotiationRoundsDraft, setNegotiationRoundsDraft] = useState<string>(
    String(config.negotiationRounds),
  );

  return (
    <div
      className="collab-config-row"
      data-originating-agent={originatingAgent}
      role="region"
      aria-label="Collaboration configuration"
    >
      <span className="collab-config-row-rail" aria-hidden="true" />

      <div className="collab-config-row-content">
        <div className="collab-config-row-chip">
          <span className="collab-config-row-chip-glyph" aria-hidden="true">
            ◆
          </span>
          <span className="collab-config-row-chip-label">/collab</span>
        </div>

        <div className="collab-config-row-field" data-field="originating-agent">
          <span className="collab-config-row-field-label">1st agent</span>
          <span
            className="collab-config-row-agent-readonly"
            data-agent={originatingAgent}
          >
            {AGENT_LABEL[originatingAgent]}
          </span>
        </div>

        <div className="collab-config-row-field" data-field="second-agent">
          <span className="collab-config-row-field-label">2nd agent</span>
          <span
            className="collab-config-row-agent-readonly"
            data-agent={config.secondAgent}
            aria-readonly="true"
            title={`Second agent is fixed to ${AGENT_LABEL[config.secondAgent]} for now`}
          >
            {AGENT_LABEL[config.secondAgent]}
          </span>
        </div>

        <div
          className="collab-config-row-field"
          data-field="negotiation-rounds"
        >
          <label
            className="collab-config-row-field-label"
            htmlFor={negotiationRoundsId}
          >
            Rounds
          </label>
          <input
            id={negotiationRoundsId}
            type="number"
            inputMode="numeric"
            min={NEGOTIATION_ROUNDS_MIN}
            max={NEGOTIATION_ROUNDS_MAX}
            step={1}
            className="collab-config-row-number"
            value={negotiationRoundsDraft}
            onChange={(event) => setNegotiationRoundsDraft(event.target.value)}
            onBlur={() => {
              const parsed = Number.parseInt(negotiationRoundsDraft, 10);
              const clamped = clampNegotiationRounds(parsed);
              setNegotiationRoundsDraft(String(clamped));
              if (clamped !== config.negotiationRounds) {
                onChange({ ...config, negotiationRounds: clamped });
              }
            }}
          />
        </div>

        <div
          className="collab-config-row-field"
          data-field="autonomous-resolution-threshold"
        >
          <span className="collab-config-row-field-label" id={thresholdGroupId}>
            Auto-resolve
          </span>
          <div
            role="radiogroup"
            aria-labelledby={thresholdGroupId}
            className="collab-config-row-segmented"
          >
            {THRESHOLD_OPTIONS.map((option) => {
              const isActive =
                config.autonomousResolutionThreshold === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className="collab-config-row-segmented-option"
                  data-active={isActive ? "true" : "false"}
                  data-value={option.value}
                  title={option.hint}
                  onClick={() =>
                    onChange({
                      ...config,
                      autonomousResolutionThreshold: option.value,
                    })
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="collab-config-row-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss /collab"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
