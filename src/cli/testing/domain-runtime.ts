import type { Invocation } from "cli-for-agents";
import {
  createTestHost,
  runForTest,
  type TestHost,
} from "cli-for-agents/testing";
import { createCommandCenterCli } from "../framework/application";
import { z } from "zod";
import type { CliEnv, CliHost } from "../transport";

/** Keep real domain route bridges while isolating kernel artifacts and input files. */
export async function runCcWithHost(
  argv: readonly string[] | Invocation,
  env: CliEnv,
  host: CliHost,
  options: { kernelHost?: TestHost } = {},
) {
  const kernel =
    options.kernelHost ?? createTestHost({ files: { "/artifacts/.keep": "" } });
  const result = await runForTest(
    createCommandCenterCli(host, {
      artifacts: { directory: "/artifacts", forbiddenRoots: [] },
    }),
    argv,
    {
      env,
      format: "path" in argv || argv.includes("--json") ? "json" : "text",
      host: {
        ...kernel,
        ...(options.kernelHost
          ? {}
          : {
              now: () => host.now?.() ?? Date.now(),
              sleep: async (ms: number, signal: AbortSignal) => {
                signal.throwIfAborted();
                await host.sleep(ms);
                signal.throwIfAborted();
              },
            }),
        files: {
          ...kernel.files,
          async read(path, limit, signal) {
            signal.throwIfAborted();
            const bytes = await host.readFileBytes(path);
            const text = bytes === null ? await host.readTextFile(path) : null;
            const content =
              bytes ?? (text === null ? null : new TextEncoder().encode(text));
            if (content === null) return kernel.files.read(path, limit, signal);
            if (content.length > limit)
              throw new RangeError("Input exceeds its declared byte limit.");
            signal.throwIfAborted();
            return content;
          },
        },
      },
    },
  );
  return { ...result, files: kernel.filesSnapshot() };
}

/** Read the native inline DTO without reconstructing legacy envelope fields. */
export function inlineDataOf(
  result: Awaited<ReturnType<typeof runCcWithHost>>,
): Record<string, unknown> {
  return z
    .object({
      payload: z.object({
        kind: z.literal("inline"),
        data: z.record(z.string(), z.unknown()),
      }),
    })
    .parse(JSON.parse(result.stdout)).payload.data;
}

export function artifactTextOf(
  result: Awaited<ReturnType<typeof runCcWithHost>>,
  index = 0,
): string {
  const manifest = result.artifacts[index];
  if (!manifest) throw new Error(`No artifact at index ${index}.`);
  const bytes = result.files[manifest.path];
  if (!bytes) throw new Error(`Artifact bytes are missing: ${manifest.path}.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
