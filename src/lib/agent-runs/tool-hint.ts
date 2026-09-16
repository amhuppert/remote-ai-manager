/**
 * Agent-facing prompt hint advertising the `cctl agent` one-shot sub-agent
 * runner. Documents this domain's CLI contract (`cctl agent run/status` and
 * the summary/referenceDocuments response shape produced by the agent-run job
 * service); consumed by session prompt composition.
 */
export function getCodexToolPromptHint(): string {
  return `Codex is available as a one-shot sub-agent via the \`cctl agent\` CLI (see the cc-cli skill). Delegate an independent, bounded task when it would improve quality or completion time, with clear ownership and a deliverable. Author \`.cc/temp/agent-prompt.json\` — \`{"backend": "codex", "prompt": "<task>"}\` — then run \`cctl agent run --file .cc/temp/agent-prompt.json --wait --json\` to run OpenAI Codex in this worktree. The result includes \`summary\` and \`referenceDocuments\` (each with \`filePath\` and \`description\`); read referenced documents before integrating the result. Without \`--wait\` it returns a runId: continue independent work, then recover the result with \`cctl agent status <runId> --json\`.`;
}
