import { discoverCommandCenterSources } from "./discovery-command-center";
import type {
  McpSourceDiscoveryInput,
  McpSourceDiscoveryResult,
} from "./types";

export type { McpSourceDiscoveryInput } from "./types";

export async function discoverAllSources(
  input: McpSourceDiscoveryInput,
): Promise<McpSourceDiscoveryResult> {
  return discoverCommandCenterSources(input);
}
