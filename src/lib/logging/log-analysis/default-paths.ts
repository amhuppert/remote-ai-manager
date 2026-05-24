import { access } from "node:fs/promises";
import path from "node:path";
import { getConfigDirPath } from "@/lib/config/loader";

export interface ResolvedServerLogPath {
  path: string;
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

  for (const candidate of checkedPaths) {
    if (await isReadable(candidate)) {
      return { path: candidate, checkedPaths };
    }
  }

  throw new Error(
    `no readable server log found; checked: ${checkedPaths.join(", ")}`,
  );
}
