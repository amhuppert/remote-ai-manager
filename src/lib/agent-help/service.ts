/**
 * The help-context service (docs/design/cc-cli/04 §4.2).
 *
 * Resolves the calling command's first path segment to a provider, invokes it,
 * and returns at most 3 blocks. A provider failure is logged as
 * `agent-help.provider_failed` and collapsed to empty blocks — help is garnish,
 * so one broken provider must never 500 the endpoint or suppress others.
 */
import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

import type { HelpContextProviderMap, HelpContextRequest } from "./providers";
import type { HelpContextQuery, HelpContextResponse } from "./schemas";

/** Hard cap on returned blocks (docs/design/cc-cli/04 §4.2). */
const MAX_BLOCKS = 3;

export interface HelpContextServiceDeps {
  providers: HelpContextProviderMap;
  /** Injected so tests can assert the failure log; defaults to the real logger. */
  logger?: Logger;
}

export interface HelpContextService {
  resolveHelpContext(query: HelpContextQuery): Promise<HelpContextResponse>;
}

/** Split a space-joined command path into non-empty segments. */
function commandSegments(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

export function createHelpContextService(
  deps: HelpContextServiceDeps,
): HelpContextService {
  const log = deps.logger ?? createLogger("agent-help");

  return {
    async resolveHelpContext(query) {
      const segments = commandSegments(query.command);
      const prefix = segments[0];
      if (prefix === undefined) return { blocks: [] };

      const provider = deps.providers.get(prefix);
      if (!provider) return { blocks: [] };

      const request: HelpContextRequest = {
        command: segments,
        ...(query.project !== undefined ? { project: query.project } : {}),
        ...(query.session !== undefined ? { session: query.session } : {}),
        ...(query.conversation !== undefined
          ? { conversation: query.conversation }
          : {}),
        ...(query.executionId !== undefined
          ? { executionId: query.executionId }
          : {}),
        ...(query.contextId !== undefined
          ? { contextId: query.contextId }
          : {}),
      };

      try {
        const blocks = await provider.provide(request);
        return { blocks: blocks.slice(0, MAX_BLOCKS) };
      } catch (error) {
        log.warn("agent-help.provider_failed", {
          prefix,
          command: segments.join(" "),
          error: getErrorMessage(error),
        });
        return { blocks: [] };
      }
    },
  };
}
