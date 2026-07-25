import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { getConfigDirPath } from "@/lib/config/loader";

export interface ResolvedServerLogPath {
  /** Primary log path (used for banner/display). */
  path: string;
  /** All log paths to read and merge. Includes scoped session+conversation logs. */
  paths: string[];
  checkedPaths: string[];
}

async function isReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * One scope tree: a root holding per-scope directories, each with a top-level
 * log named `rootLog` plus a `conversations/` directory.
 */
interface ScopeTree {
  root: string;
  rootLog: string;
}

/**
 * Discover every scoped log under `<configDir>/logs/`.
 *
 * Layout:
 *   <configDir>/logs/sessions/<projectSlug>__<sessionSlug>/session.log
 *   <configDir>/logs/sessions/<projectSlug>__<sessionSlug>/conversations/<conversationSlug>.log
 *   <configDir>/logs/projects/<projectSlug>/project.log
 *   <configDir>/logs/projects/<projectSlug>/conversations/<conversationSlug>.log
 *
 * The `projects/` tree holds project conversations, which have no owning
 * session — their session-keyed store value is the internal sentinel, which
 * never appears in a path (project-conversation-parity R1.3).
 */
export async function discoverScopedLogPaths(
  configDir: string,
): Promise<string[]> {
  const trees: ScopeTree[] = [
    { root: path.join(configDir, "logs", "sessions"), rootLog: "session.log" },
    { root: path.join(configDir, "logs", "projects"), rootLog: "project.log" },
  ];
  const results: string[] = [];

  for (const tree of trees) {
    for (const scopeDir of await safeReaddir(tree.root)) {
      const scopePath = path.join(tree.root, scopeDir);
      const rootLog = path.join(scopePath, tree.rootLog);
      if (await isReadable(rootLog)) results.push(rootLog);

      const conversationsDir = path.join(scopePath, "conversations");
      for (const conversationFile of await safeReaddir(conversationsDir)) {
        if (!conversationFile.endsWith(".log")) continue;
        const conversationLog = path.join(conversationsDir, conversationFile);
        if (await isReadable(conversationLog)) results.push(conversationLog);
      }
    }
  }

  return results;
}

export async function resolveDefaultServerLogPath(): Promise<ResolvedServerLogPath> {
  const configDir = getConfigDirPath();
  const checkedPaths = [
    process.env["CC_LOG_FILE"],
    path.join(configDir, "logs", "global.log"),
    path.join(configDir, "cc-debug.log"),
    path.join(process.cwd(), ".config", "logs", "global.log"),
    path.join(process.cwd(), ".config", "cc-debug.log"),
  ].filter(
    (candidate): candidate is string =>
      candidate !== undefined && candidate !== "",
  );

  let primary: string | undefined;
  for (const candidate of checkedPaths) {
    if (await isReadable(candidate)) {
      primary = candidate;
      break;
    }
  }

  const scopedPaths = await discoverScopedLogPaths(configDir);
  const allChecked = [...checkedPaths, ...scopedPaths];

  if (primary === undefined && scopedPaths.length === 0) {
    throw new Error(
      `no readable server log found; checked: ${checkedPaths.join(", ")}`,
    );
  }

  const paths = primary !== undefined ? [primary, ...scopedPaths] : scopedPaths;
  return {
    path: paths[0] as string,
    paths,
    checkedPaths: allChecked,
  };
}
