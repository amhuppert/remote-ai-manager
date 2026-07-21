/**
 * Agent-facing prompt hint advertising the `cctl agent` one-shot sub-agent
 * runner. Documents this domain's CLI contract (`cctl agent run/status` and
 * the summary/referenceDocuments response shape produced by the agent-run job
 * service); consumed by session prompt composition.
 */
export function getCodexToolPromptHint(): string {
  return `Codex is available as a one-shot sub-agent via the \`cctl agent\` CLI (see the cc-cli skill). Author a \`prompt.json\` — \`{"backend": "codex", "prompt": "<task>"}\` — then run \`cctl agent run --file prompt.json --wait\` to run OpenAI Codex in this worktree; it returns a JSON \`summary\` and a \`referenceDocuments\` array (files Codex created, each with \`filePath\` and \`description\`) — Read those documents when the summary points to them. Without \`--wait\` it returns a runId; recover the result with \`cctl agent status <runId>\`.`;
}
