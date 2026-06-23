import { readConfig } from "@/lib/config/loader";
import ConnectedWorkflowBuilderPage from "./components/ConnectedWorkflowBuilderPage";
import { buildDefaultImplementerConfig } from "./WorkflowsBuilderPage";

/**
 * Top-level `/templates` route: the workflow builder bound to the global
 * (cross-project) template tier. Its sidebar lists every global template and
 * create/edit/save/delete write to the global tier — no project binding. Runs
 * are still launched from a session's templates page, which needs a worktree.
 */
export default async function GlobalWorkflowsBuilderPage(): Promise<React.JSX.Element> {
  const config = await readConfig();
  return (
    <ConnectedWorkflowBuilderPage
      scope={{ kind: "global" }}
      defaultImplementerConfig={buildDefaultImplementerConfig(config)}
      codexConfig={config.codex}
    />
  );
}
