import {
  createCodexAppServerClient,
  type AppServerClientOptions,
  type AppServerClient,
} from "./app-server-client";
import {
  CodexSkillCatalog,
  type CodexNativeSkill,
  type CodexNativeSkillSelector,
} from "./skill-catalog";
import { ensureCodexManagedSkillsBridgeForLaunch } from "./managed-skills-bridge";
import { buildChildEnv } from "@/lib/shared/child-env";
import { toStringEnv } from "./shared";
import { CODEX_NATIVE_MEMORY_CONFIG } from "./native-memory";
import { publishEvent } from "@/lib/events/publication";
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
async function withCodexSkillCatalog<T>(
  consume: (catalog: CodexSkillCatalog) => Promise<T>,
  cwd: string,
  config: Record<string, unknown> = {},
  dependencies: Partial<CodexSkillDiscoveryDeps> = {},
  prepareManagedSkills = true,
) {
  const deps = { ...defaults, ...dependencies };
  if (prepareManagedSkills) await deps.ensureManagedSkillsBridge(cwd);
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
    const commands = await consume(catalog);
    if (failure) throw failure;
    return commands;
  } finally {
    await client.close();
  }
}

export function discoverCodexSkillCommands(
  cwd: string,
  config: Record<string, unknown> = {},
  dependencies: Partial<CodexSkillDiscoveryDeps> = {},
) {
  return withCodexSkillCatalog(
    (catalog) => catalog.commands(),
    cwd,
    config,
    dependencies,
  );
}

export function discoverCodexSkillInventory(
  cwd: string,
): Promise<CodexNativeSkill[]> {
  return withCodexSkillCatalog(
    (catalog) => catalog.inventory(),
    cwd,
    {},
    {},
    false,
  );
}

export function discoverCodexSkillSelectors(
  cwd: string,
): Promise<CodexNativeSkillSelector[]> {
  return withCodexSkillCatalog(
    (catalog) => catalog.selectors(),
    cwd,
    {},
    {},
    false,
  );
}
