import { renderRuntimeSpecInstructions } from "./native-spec-guidance";

const NATIVE_SPEC_AUTHORING_INSTRUCTIONS = renderRuntimeSpecInstructions();

export function expandNativeSpecCommandForAgent(prompt: string): string {
  const trimmed = prompt.trimStart();
  const match = /^\/spec(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return prompt;

  const request = (match[1] ?? "").trim();
  if (request.length === 0) return NATIVE_SPEC_AUTHORING_INSTRUCTIONS;

  return `${NATIVE_SPEC_AUTHORING_INSTRUCTIONS}\n\n<spec-request>\n${request}\n</spec-request>`;
}
