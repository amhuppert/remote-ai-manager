/**
 * Agent-facing prompt hint advertising `cctl run launch` to a conversation
 * that may own a run. Documents this domain's CLI contract: the launch file,
 * its check verb, the owner's wakes and the owner commands.
 */
export function getRunToolPromptHint(): string {
  return `A supervised agent can take an independent, bounded task when that would improve quality or completion time (see the cc-cli skill). Write \`.cc/temp/run.json\` as \`{"brief": "<the task>"}\`: the brief is the only required field and must stand alone, because the agent does not see this conversation; add \`"backend": "codex"\` (or \`claude\`, \`cursor\`) to choose its backend, and \`tasks\`, \`acceptanceCriteria\`, \`checks\` or \`reviewers\` when the work needs them. Run \`cctl run launch-check --file .cc/temp/run.json\`, then \`cctl run launch --file .cc/temp/run.json\`. The agent writes this session's worktree, so until its result arrives, edit no files here: read, plan or end your turn. Its questions and its result wake this conversation as subscription updates. Read its progress with \`cctl run show <run-id>\` and answer a question with \`cctl run answer <run-id> --question <question-id> --text "<answer>"\`. For a workflow of several agents, use the run-planning skill.`;
}
