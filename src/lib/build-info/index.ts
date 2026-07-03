import { BUILD_INFO } from "./build-info.generated";
import { formatBuildStamp } from "./stamp";

export type { BuildInfo } from "./stamp";
export { buildInfoSchema, formatBuildStamp } from "./stamp";
export { BUILD_INFO };

/** The stamp of this build (git SHA + build time), shared by server and CLI. */
export function getBuildStamp(): string {
  return formatBuildStamp(BUILD_INFO);
}
