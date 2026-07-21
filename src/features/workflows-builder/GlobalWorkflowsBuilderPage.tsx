import ConnectedWorkflowBuilderPage from "./components/ConnectedWorkflowBuilderPage";

/**
 * Top-level `/templates` route: the workflow builder bound to the global
 * (cross-project) template tier. Its sidebar lists every global template and
 * create/edit/save/delete write to the global tier — no project binding. Runs
 * are still launched from a session's templates page, which needs a worktree.
 */
export default function GlobalWorkflowsBuilderPage(): React.JSX.Element {
  return <ConnectedWorkflowBuilderPage scope={{ kind: "global" }} />;
}
