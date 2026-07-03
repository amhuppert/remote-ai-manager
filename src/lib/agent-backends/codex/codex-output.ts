/**
 * Codex sub-agent I/O contract: the structured-output JSON schema, the prompt
 * preamble/wrapper that constrains Codex to it, the response parser, and the
 * agent-facing `cctl codex` prompt hint. Shared by the codex-run job service
 * (`@/lib/codex-runs/service`) and the session prompt composition.
 */

export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    referenceDocuments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          description: { type: "string" },
        },
        required: ["filePath", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "referenceDocuments"],
  additionalProperties: false,
} as const;

const CODEX_PROMPT_PREAMBLE = `You MUST write all detailed output as files in the \`memory-bank/codex/\` directory (relative to the workspace root). Use markdown files primarily, but other formats are acceptable when appropriate.

Your response will be constrained to a JSON schema with two fields:
- "summary": A concise summary of what you did and the results. Maximum 1000 characters. This is the only text the caller sees directly, so make it informative.
- "referenceDocuments": An array of documents you created, each with "filePath" (path relative to workspace root) and "description" (what the file contains and when it should be read).

Write detailed analysis, code examples, plans, and explanations to files — do NOT put them in the summary.`;

export function wrapCodexPrompt(prompt: string): string {
  return `${CODEX_PROMPT_PREAMBLE}\n\n---\n\nTask:\n${prompt}`;
}

export interface CodexStructuredResponse {
  summary: string;
  referenceDocuments: Array<{
    filePath: string;
    description: string;
  }>;
}

export function parseCodexStructuredResponse(
  input: unknown,
): CodexStructuredResponse | null {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== "string") return null;
  if (!Array.isArray(obj.referenceDocuments)) return null;

  for (const doc of obj.referenceDocuments) {
    if (typeof doc !== "object" || doc === null) return null;
    const d = doc as Record<string, unknown>;
    if (typeof d.filePath !== "string" || typeof d.description !== "string")
      return null;
  }

  return {
    summary: obj.summary,
    referenceDocuments: (
      obj.referenceDocuments as Array<Record<string, unknown>>
    ).map((d) => ({
      filePath: d.filePath as string,
      description: d.description as string,
    })),
  };
}

export function getCodexToolPromptHint(enabled: boolean): string | null {
  if (!enabled) return null;
  return `Codex is available as a one-shot sub-agent via the \`cctl codex\` CLI (see the cc-cli skill). Author a \`prompt.json\` — \`{"prompt": "<task>"}\` — then run \`cctl codex run --file prompt.json --wait\` to run OpenAI Codex in this worktree; it returns a JSON \`summary\` and a \`referenceDocuments\` array (files Codex created, each with \`filePath\` and \`description\`) — Read those documents when the summary points to them. Without \`--wait\` it returns a runId; recover the result with \`cctl codex status <runId>\`.`;
}
