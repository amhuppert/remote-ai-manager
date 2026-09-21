import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { Cursor, type ModelListItem } from "@cursor/sdk";

import {
  backendModelCatalogSchema,
  type BackendModelCatalog,
} from "../src/lib/agent-backends/schemas";
import {
  analyzeCursorModelAliases,
  buildCursorModelCatalog,
} from "../src/lib/agent-backends/cursor/model-catalog-generation";
import { parseGeneratedCursorModelCatalog } from "../src/lib/agent-backends/cursor/model-catalog";
import { CURSOR_SDK_PINNED_VERSION } from "../src/lib/agent-backends/cursor/sdk-pin";

export interface CursorModelsCommandDeps {
  sdkVersion: string;
  readArtifact(): Promise<unknown>;
  writeArtifact(catalog: BackendModelCatalog): Promise<void>;
  listModels(apiKey: string): Promise<ModelListItem[]>;
  now(): Date;
  writeOutput(message: string): void;
}

export async function checkCursorModelCatalog(
  deps: CursorModelsCommandDeps,
): Promise<BackendModelCatalog> {
  const catalog = parseGeneratedCursorModelCatalog(
    await deps.readArtifact(),
    deps.sdkVersion,
  );
  const parameterCount = catalog.models.reduce(
    (count, model) => count + model.parameters.length,
    0,
  );
  const variantCount = catalog.models.reduce(
    (count, model) => count + model.variants.length,
    0,
  );
  deps.writeOutput(
    `Cursor model catalog valid: ${plural(catalog.models.length, "model")}, ${plural(parameterCount, "parameter")}, ${plural(variantCount, "variant")}.`,
  );
  return catalog;
}

export async function refreshCursorModelCatalog(
  apiKey: string | null | undefined,
  deps: CursorModelsCommandDeps,
): Promise<BackendModelCatalog> {
  if (apiKey === null || apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "CURSOR_API_KEY is required to refresh the Cursor model catalog.",
    );
  }

  const previousCatalog = backendModelCatalogSchema.parse(
    await deps.readArtifact(),
  );
  if (previousCatalog.backend !== "cursor") {
    throw new Error(
      `Generated Cursor model catalog declares backend "${previousCatalog.backend}".`,
    );
  }
  const models = await deps.listModels(apiKey);
  const aliases = analyzeCursorModelAliases(models);
  const catalog = buildCursorModelCatalog(models, {
    generatedAt: deps.now().toISOString(),
    sdkVersion: deps.sdkVersion,
  });
  await deps.writeArtifact(catalog);

  const parameterCount = catalog.models.reduce(
    (count, model) => count + model.parameters.length,
    0,
  );
  const variantCount = catalog.models.reduce(
    (count, model) => count + model.variants.length,
    0,
  );
  deps.writeOutput(
    `Cursor model catalog refreshed: ${plural(catalog.models.length, "model")}, ${plural(parameterCount, "parameter")}, ${plural(variantCount, "variant")}.`,
  );
  deps.writeOutput(summarizeCatalogDiff(previousCatalog, catalog));
  if (aliases.omissions.length > 0) {
    const detail = aliases.omissions
      .map((omission) => `${omission.alias} -> ${omission.modelIds.join(", ")}`)
      .join("; ");
    deps.writeOutput(
      `Cursor aliases omitted as ambiguous: ${plural(aliases.omissions.length, "alias", "aliases")} (${detail}).`,
    );
  }
  return catalog;
}

/**
 * What a build does: take the latest models Cursor serves for the pinned SDK
 * when that is possible, and otherwise stand on the checked-in artifact.
 *
 * A build must not depend on a credential or on Cursor's availability — the
 * artifact in the repository is already a valid catalog — so an absent key or
 * an unreachable API degrades to the `--check` verdict rather than failing.
 * What still fails the build is an artifact that does not parse or was
 * generated for a different SDK version, because that one is Command Center's
 * own mistake and shipping past it would serve models the adapter cannot run.
 */
export async function syncCursorModelCatalog(
  apiKey: string | null | undefined,
  deps: CursorModelsCommandDeps,
): Promise<BackendModelCatalog> {
  if (apiKey === null || apiKey === undefined || apiKey.length === 0) {
    deps.writeOutput(
      "CURSOR_API_KEY is not set, so the Cursor model catalog was not refreshed; validating the checked-in artifact instead.",
    );
    return checkCursorModelCatalog(deps);
  }

  try {
    return await refreshCursorModelCatalog(apiKey, deps);
  } catch (error) {
    deps.writeOutput(
      `Cursor model discovery failed, so the catalog was not refreshed; validating the checked-in artifact instead: ${safeErrorMessage(error, apiKey)}`,
    );
    return checkCursorModelCatalog(deps);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function summarizeCatalogDiff(
  previous: BackendModelCatalog,
  next: BackendModelCatalog,
): string {
  const previousModels = new Map(
    previous.models.map((model) => [model.id, model]),
  );
  const nextModels = new Map(next.models.map((model) => [model.id, model]));
  const addedModels = [...nextModels.keys()]
    .filter((id) => !previousModels.has(id))
    .sort();
  const removedModels = [...previousModels.keys()]
    .filter((id) => !nextModels.has(id))
    .sort();
  const changedModels = [...nextModels.keys()]
    .filter((id) => {
      const prior = previousModels.get(id);
      return (
        prior !== undefined &&
        stableJson(prior) !== stableJson(nextModels.get(id))
      );
    })
    .sort();

  const parameterChanges: string[] = [];
  for (const modelId of [...nextModels.keys()].sort()) {
    const priorModel = previousModels.get(modelId);
    const nextModel = nextModels.get(modelId);
    if (priorModel === undefined || nextModel === undefined) continue;
    const priorParameters = new Map(
      priorModel.parameters.map((parameter) => [parameter.id, parameter]),
    );
    const nextParameters = new Map(
      nextModel.parameters.map((parameter) => [parameter.id, parameter]),
    );
    const tokens = [
      ...[...nextParameters.keys()]
        .filter((id) => !priorParameters.has(id))
        .sort()
        .map((id) => `+${id}`),
      ...[...priorParameters.keys()]
        .filter((id) => !nextParameters.has(id))
        .sort()
        .map((id) => `-${id}`),
      ...[...nextParameters.keys()]
        .filter((id) => {
          const prior = priorParameters.get(id);
          return (
            prior !== undefined &&
            stableJson(prior) !== stableJson(nextParameters.get(id))
          );
        })
        .sort()
        .map((id) => `~${id}`),
    ];
    if (tokens.length > 0) {
      parameterChanges.push(`${modelId}(${tokens.join(", ")})`);
    }
  }

  const modelTokens = [
    ...addedModels.map((id) => `+${id}`),
    ...removedModels.map((id) => `-${id}`),
    ...changedModels.map((id) => `~${id}`),
  ];
  if (modelTokens.length === 0 && parameterChanges.length === 0) {
    return "Cursor model catalog diff: no model or parameter changes.";
  }
  return [
    `Cursor model catalog diff: models ${modelTokens.join(", ") || "unchanged"}`,
    `parameters ${parameterChanges.join("; ") || "unchanged"}.`,
  ].join("; ");
}

function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const ARTIFACT_PATH = path.resolve(
  import.meta.dirname,
  "../src/lib/agent-backends/cursor/generated-model-catalog.json",
);

async function readInstalledSdkVersion(): Promise<string> {
  const packagePath = path.resolve(
    import.meta.dirname,
    "../node_modules/@cursor/sdk/package.json",
  );
  const value: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error("The installed @cursor/sdk package has no valid version.");
  }
  return value.version;
}

async function writeArtifactAtomically(
  catalog: BackendModelCatalog,
): Promise<void> {
  const temporaryPath = `${ARTIFACT_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, ARTIFACT_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function productionDeps(): Promise<CursorModelsCommandDeps> {
  const sdkVersion = await readInstalledSdkVersion();
  if (sdkVersion !== CURSOR_SDK_PINNED_VERSION) {
    throw new Error(
      `Installed @cursor/sdk version "${sdkVersion}" does not match the adapter pin "${CURSOR_SDK_PINNED_VERSION}".`,
    );
  }
  return {
    sdkVersion,
    async readArtifact() {
      return JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as unknown;
    },
    writeArtifact: writeArtifactAtomically,
    listModels: (apiKey) => Cursor.models.list({ apiKey }),
    now: () => new Date(),
    writeOutput: (message) => console.log(message),
  };
}

function safeErrorMessage(error: unknown, secret: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  if (secret === undefined || secret.length === 0) return message;
  return message.split(secret).join("[redacted]");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (
    rest.length > 0 ||
    (command !== "--check" && command !== "--refresh" && command !== "--sync")
  ) {
    throw new Error(
      "Usage: bun scripts/cursor-models.ts --check|--refresh|--sync",
    );
  }
  const deps = await productionDeps();
  if (command === "--check") {
    await checkCursorModelCatalog(deps);
    return;
  }
  if (command === "--sync") {
    await syncCursorModelCatalog(process.env.CURSOR_API_KEY, deps);
    return;
  }
  await refreshCursorModelCatalog(process.env.CURSOR_API_KEY, deps);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `Cursor model catalog command failed: ${safeErrorMessage(error, process.env.CURSOR_API_KEY)}`,
    );
    process.exitCode = 1;
  });
}
