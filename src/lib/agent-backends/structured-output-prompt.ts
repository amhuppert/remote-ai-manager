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
