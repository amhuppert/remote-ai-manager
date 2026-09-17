import type { BuildInfo } from "./stamp";

/** One header-safe token shared by the published server and its CLI. */
export function formatBuildStamp(info: BuildInfo): string {
  return `${info.sha}-${info.buildTime}`;
}
