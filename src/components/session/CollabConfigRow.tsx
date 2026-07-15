"use client";

import { useId, useState } from "react";
import { backendLabel } from "@/lib/agent-backends/catalog";

export const COLLAB_RUNNING_TOOLTIP =
  "collaboration in progress · stop the run to continue";

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
  claude: backendLabel("claude"),
  codex: backendLabel("codex"),
};

const fieldLabelClass =
  "font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase text-text-secondary";
const agentReadonlyClass =
  "rounded-sm bg-bg-raised px-[8px] py-[3px] font-mono text-[0.78rem] font-semibold data-[agent=claude]:text-cyan data-[agent=codex]:text-violet";

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
      className="relative flex w-full items-start gap-md rounded-t-md border border-b-0 border-solid border-border-subtle bg-bg-base py-sm pr-md pl-[calc(var(--space-md)+4px)]"
      data-originating-agent={originatingAgent}
      role="region"
      aria-label="Collaboration configuration"
    >
      <span
        className="absolute top-[-1px] bottom-[-1px] left-0 w-[4px] rounded-tl-md bg-cyan shadow-[0_0_16px_-4px_var(--cyan-glow)]"
        aria-hidden="true"
      />

      <div className="flex flex-auto flex-wrap items-center gap-md">
        <div className="inline-flex items-center gap-[6px] rounded-full bg-violet-glow px-[10px] py-[3px] font-mono text-[0.74rem] font-bold tracking-[0.06em] text-violet">
          <span className="text-[0.85rem] leading-none" aria-hidden="true">
            ◆
          </span>
          <span className="lowercase">/collab</span>
        </div>

        <div
          className="inline-flex items-center gap-[6px]"
          data-field="originating-agent"
        >
          <span className={fieldLabelClass}>1st agent</span>
          <span className={agentReadonlyClass} data-agent={originatingAgent}>
            {AGENT_LABEL[originatingAgent]}
          </span>
        </div>

        <div
          className="inline-flex items-center gap-[6px]"
          data-field="second-agent"
        >
          <span className={fieldLabelClass}>2nd agent</span>
          <span
            className={agentReadonlyClass}
            data-agent={config.secondAgent}
            aria-readonly="true"
            title={`Second agent is fixed to ${AGENT_LABEL[config.secondAgent]} for now`}
          >
            {AGENT_LABEL[config.secondAgent]}
          </span>
        </div>

        <div
          className="inline-flex items-center gap-[6px]"
          data-field="negotiation-rounds"
        >
          <label className={fieldLabelClass} htmlFor={negotiationRoundsId}>
            Rounds
          </label>
          <input
            id={negotiationRoundsId}
            type="number"
            inputMode="numeric"
            min={NEGOTIATION_ROUNDS_MIN}
            max={NEGOTIATION_ROUNDS_MAX}
            step={1}
            className="w-[64px] rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[4px] text-center font-mono text-[0.78rem] text-text-primary outline-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] focus:border-cyan-dim focus:shadow-[0_0_0_3px_var(--cyan-glow)]"
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
          className="inline-flex items-center gap-[6px]"
          data-field="autonomous-resolution-threshold"
        >
          <span className={fieldLabelClass} id={thresholdGroupId}>
            Auto-resolve
          </span>
          <div
            role="radiogroup"
            aria-labelledby={thresholdGroupId}
            className="inline-flex gap-[2px] rounded-sm border border-solid border-border-default bg-bg-base p-[2px]"
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
                  className="cursor-pointer rounded-[calc(var(--radius-sm)-2px)] border-0 bg-transparent px-[10px] py-[4px] font-mono text-[0.74rem] font-semibold tracking-[0.04em] text-text-secondary uppercase [transition:background-color_0.15s_ease,color_0.15s_ease] focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-2 data-[active=false]:hover:text-text-primary data-[active=true]:bg-cyan-glow data-[active=true]:text-cyan"
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
        className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center self-start rounded-sm border border-solid border-border-subtle bg-transparent text-[1rem] leading-none text-text-secondary [transition:border-color_0.15s_ease,color_0.15s_ease] hover:border-red-dim hover:text-red-text focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-2 max-768:h-[44px] max-768:w-[44px]"
        onClick={onDismiss}
        aria-label="Dismiss /collab"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
