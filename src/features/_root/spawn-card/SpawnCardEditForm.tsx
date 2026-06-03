import { spawnAgentSchema, spawnModeSchema } from "@/lib/chat-spawning/schemas";
import type { EditableField, EditableSession } from "./useSpawnCard";

/**
 * Editable form for one proposed session — name, branch, target, agent, mode,
 * and the optional initial prompt. Every change flows up through `onChange` so
 * the submitted payload reflects exactly what the user edited.
 */
export default function SpawnCardEditForm({
  index,
  session,
  onChange,
}: {
  index: number;
  session: EditableSession;
  onChange: (index: number, field: EditableField, value: string) => void;
}): React.JSX.Element {
  return (
    <div className="spawn-card-edit">
      <label className="spawn-card-edit__field">
        <span className="cc-meta-label">Name</span>
        <input
          className="prompt-input spawn-card-edit__input"
          aria-label={`Session ${index + 1} name`}
          value={session.name}
          onChange={(e) => onChange(index, "name", e.target.value)}
        />
      </label>
      <label className="spawn-card-edit__field">
        <span className="cc-meta-label">Branch</span>
        <input
          className="prompt-input spawn-card-edit__input"
          aria-label={`Session ${index + 1} branch`}
          value={session.branch}
          onChange={(e) => onChange(index, "branch", e.target.value)}
        />
      </label>
      <label className="spawn-card-edit__field">
        <span className="cc-meta-label">Target</span>
        <input
          className="prompt-input spawn-card-edit__input"
          aria-label={`Session ${index + 1} target`}
          value={session.target}
          onChange={(e) => onChange(index, "target", e.target.value)}
        />
      </label>
      <label className="spawn-card-edit__field">
        <span className="cc-meta-label">Agent</span>
        <select
          className="prompt-input spawn-card-edit__input"
          aria-label={`Session ${index + 1} agent`}
          value={session.agent}
          onChange={(e) => onChange(index, "agent", e.target.value)}
        >
          {spawnAgentSchema.options.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
      </label>
      <label className="spawn-card-edit__field">
        <span className="cc-meta-label">Mode</span>
        <select
          className="prompt-input spawn-card-edit__input"
          aria-label={`Session ${index + 1} mode`}
          value={session.mode}
          onChange={(e) => onChange(index, "mode", e.target.value)}
        >
          {spawnModeSchema.options.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>
      <label className="spawn-card-edit__field spawn-card-edit__field--wide">
        <span className="cc-meta-label">Initial prompt</span>
        <textarea
          className="prompt-input spawn-card-edit__input"
          aria-label={`Session ${index + 1} initial prompt`}
          value={session.initialPrompt}
          onChange={(e) => onChange(index, "initialPrompt", e.target.value)}
          rows={2}
        />
      </label>
    </div>
  );
}
