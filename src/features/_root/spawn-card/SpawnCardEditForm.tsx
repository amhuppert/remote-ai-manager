import { spawnAgentSchema, spawnModeSchema } from "@/lib/chat-spawning/schemas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import type { EditableField, EditableSession } from "./useSpawnCard";

// Small uppercase mono caption above each field.
const META_LABEL_CLASS =
  "font-mono text-[0.7rem] font-medium uppercase tracking-[0.06em] text-text-tertiary";

// Shared prompt input recipe, stretched to fill its field.
const INPUT_CLASS = "prompt-input w-full";

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
    <div className="grid grid-cols-2 gap-sm rounded-md border border-solid border-border-dim bg-bg-base p-md">
      <label className="flex flex-col gap-2xs">
        <span className={META_LABEL_CLASS}>Name</span>
        <input
          className={INPUT_CLASS}
          aria-label={`Session ${index + 1} name`}
          value={session.name}
          onChange={(e) => onChange(index, "name", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-2xs">
        <span className={META_LABEL_CLASS}>Branch</span>
        <input
          className={INPUT_CLASS}
          aria-label={`Session ${index + 1} branch`}
          value={session.branch}
          onChange={(e) => onChange(index, "branch", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-2xs">
        <span className={META_LABEL_CLASS}>Target</span>
        <input
          className={INPUT_CLASS}
          aria-label={`Session ${index + 1} target`}
          value={session.target}
          onChange={(e) => onChange(index, "target", e.target.value)}
        />
      </label>
      <div className="flex flex-col gap-2xs">
        <span className={META_LABEL_CLASS}>Agent</span>
        <Select
          value={session.agent}
          onValueChange={(value) => onChange(index, "agent", value)}
        >
          <SelectTrigger
            aria-label={`Session ${index + 1} agent`}
            layoutClassName="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spawnAgentSchema.options.map((agent) => (
              <SelectItem key={agent} value={agent}>
                {agent}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2xs">
        <span className={META_LABEL_CLASS}>Mode</span>
        <Select
          value={session.mode}
          onValueChange={(value) => onChange(index, "mode", value)}
        >
          <SelectTrigger
            aria-label={`Session ${index + 1} mode`}
            layoutClassName="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spawnModeSchema.options.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="col-span-2 flex flex-col gap-2xs">
        <span className={META_LABEL_CLASS}>Initial prompt</span>
        <textarea
          className={INPUT_CLASS}
          aria-label={`Session ${index + 1} initial prompt`}
          value={session.initialPrompt}
          onChange={(e) => onChange(index, "initialPrompt", e.target.value)}
          rows={2}
        />
      </label>
    </div>
  );
}
