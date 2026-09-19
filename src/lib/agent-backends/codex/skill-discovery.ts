import {
  createCodexAppServerClient,
  type AppServerClientOptions,
  type AppServerClient,
} from "./app-server-client";
import { CodexSkillCatalog } from "./skill-catalog";
import { ensureCodexManagedSkillsBridgeForLaunch } from "./managed-skills-bridge";
import { buildChildEnv } from "@/lib/shared/child-env";
import { toStringEnv } from "./shared";
import { CODEX_NATIVE_MEMORY_CONFIG } from "./native-memory";
import { publishEvent } from "@/lib/events/publication";
import type { BackendSkillCatalogFacet } from "../descriptor";
import { translateCodexRuntimeCapabilities } from "./runtime-config";

export const codexSkillCatalog: BackendSkillCatalogFacet = {
  getCommands({ worktreePath, capabilities }) {
    const config = capabilities
      ? translateCodexRuntimeCapabilities(capabilities).config
      : {};
    return discoverCodexSkillCommands(worktreePath, { ...config });
  },
};

export interface CodexSkillDiscoveryDeps {
  createAppServer(options: AppServerClientOptions): AppServerClient;
  ensureManagedSkillsBridge(cwd: string): Promise<unknown>;
  buildEnv(): Record<string, string>;
}
const defaults: CodexSkillDiscoveryDeps = {
  createAppServer: createCodexAppServerClient,
  ensureManagedSkillsBridge: ensureCodexManagedSkillsBridgeForLaunch,
  buildEnv: () => toStringEnv(buildChildEnv()),
};

export function publishCodexSkillsChanged(): void {
  // Native notifications do not identify which shared skill root changed.
  publishEvent({ type: "commands-changed" });
}

/** Read-only discovery has a bounded process lifetime and never starts a model turn. */
export async function discoverCodexSkillCommands(
  cwd: string,
  config: Record<string, unknown> = {},
  dependencies: Partial<CodexSkillDiscoveryDeps> = {},
) {
  const deps = { ...defaults, ...dependencies };
  await deps.ensureManagedSkillsBridge(cwd);
  let failure: Error | undefined;
  const client = deps.createAppServer({
    cwd,
    env: deps.buildEnv(),
    config: { ...config, ...CODEX_NATIVE_MEMORY_CONFIG },
    async onFrame() {},
    onFailure(error) {
      failure = error;
    },
    onNotification(message) {
      if (message.method === "skills/changed") catalog.invalidate();
    },
  });
  const catalog = new CodexSkillCatalog(client, cwd);
  try {
    await client.request("initialize", {
      clientInfo: { name: "command-center", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    });
    client.notify("initialized");
    const commands = await catalog.commands();
    if (failure) throw failure;
    return commands;
  } finally {
    await client.close();
  }
}
