const STRUCTURED_OUTPUT_CONTRACT =
  "Your final message must be a single JSON object conforming to this JSON Schema. Output only the JSON object — no prose before or after it, no markdown fence required.";

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function renderStructuredOutputInstruction(
  schema: Record<string, unknown>,
): string {
  const renderedSchema = JSON.stringify(sortJsonValue(schema), null, 2);
  return `${STRUCTURED_OUTPUT_CONTRACT}

\`\`\`json
${renderedSchema}
\`\`\``;
}

export function appendStructuredOutputInstruction(
  prompt: string,
  schema: Record<string, unknown>,
): string {
  const instruction = renderStructuredOutputInstruction(schema);
  if (prompt.includes(instruction)) return prompt;
  return prompt.length > 0 ? `${prompt}\n\n${instruction}` : instruction;
}

export const STRUCTURED_OUTPUT_WORK_INSTRUCTION =
  "Answer in prose, do not emit JSON. A follow-up turn will ask you to format the result.";
export const STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES = 12;
export const STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS = 512;
export const STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATHS = 12;
export const STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATH_CHARS = 256;

/** Format the work already in this session; never reconstruct it from a text fragment. */
export function renderFormatTurnPrompt(
  schema: Record<string, unknown>,
  issues: readonly string[] = [],
): string {
  const feedback =
    issues.length === 0
      ? ""
      : `\n\nValidation issues:\n${issues
          .slice(0, STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES)
          .map(
            (issue) =>
              `- ${issue.slice(0, STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS)}`,
          )
          .join("\n")}`;
  return `Convert your previous response into the requested JSON object. Preserve the substantive content of the work already completed in this session. Do not run tools.\n\n${renderStructuredOutputInstruction(schema)}${feedback}`;
}
