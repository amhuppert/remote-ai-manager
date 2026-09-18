import type { ProbeModelSelection } from "../checkpoint-continuation/environment";

export function probeModelSelection(
  backend: "claude" | "codex",
  model: string | undefined,
  reasoning: string,
): ProbeModelSelection | null {
  if (!model) return null;
  const parameters: Record<string, string> =
    backend === "codex" ? { fast: "false" } : {};
  if (reasoning !== "none")
    parameters[backend === "codex" ? "reasoning" : "effort"] = reasoning;
  return { modelId: model, parameters };
}
