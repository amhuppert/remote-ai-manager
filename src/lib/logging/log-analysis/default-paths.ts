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
 * Discover all scoped session/conversation logs under `<configDir>/logs/sessions/`.
 *
 * Layout:
 *   <configDir>/logs/sessions/<projectSlug>__<sessionSlug>/session.log
 *   <configDir>/logs/sessions/<projectSlug>__<sessionSlug>/conversations/<conversationSlug>.log
 */
async function discoverScopedLogPaths(configDir: string): Promise<string[]> {
  const sessionsRoot = path.join(configDir, "logs", "sessions");
  const sessionDirs = await safeReaddir(sessionsRoot);
  const results: string[] = [];

  for (const sessionDir of sessionDirs) {
    const sessionPath = path.join(sessionsRoot, sessionDir);
    const sessionLog = path.join(sessionPath, "session.log");
    if (await isReadable(sessionLog)) results.push(sessionLog);

    const conversationsDir = path.join(sessionPath, "conversations");
    const conversationFiles = await safeReaddir(conversationsDir);
    for (const conversationFile of conversationFiles) {
      if (!conversationFile.endsWith(".log")) continue;
      const conversationLog = path.join(conversationsDir, conversationFile);
      if (await isReadable(conversationLog)) results.push(conversationLog);
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
