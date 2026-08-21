import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { BUILD_INFO } from "./build-info.generated";
import {
  formatBuildStamp,
  pinBuildIdentity,
  type BuildIdentityPin,
  type BuildInfo,
} from "./stamp";

export type { BuildInfo } from "./stamp";
export { buildInfoSchema, formatBuildStamp } from "./stamp";
export { BUILD_INFO };

/**
 * Pinned on globalThis rather than in a module-local: the pin has to survive the
 * very reload it exists to absorb, and Next compiles this module into several
 * bundle graphs (node runtime, edge middleware) that must agree on one identity.
 */
const BUILD_IDENTITY_PIN = "__cc_build_identity_pin";

/**
 * The build this process is running — fixed at its first read, so a rebuilt
 * `build-info.generated.ts` cannot retarget a live server (see
 * `pinBuildIdentity`). Server code reads identity through here; the CLI is a
 * one-shot process and reads `BUILD_INFO` directly.
 */
export function getBuildInfo(): BuildInfo {
  return pinBuildIdentity(
    getGlobalSingleton<BuildIdentityPin>(BUILD_IDENTITY_PIN, () => ({})),
    BUILD_INFO,
  );
}

/** The stamp of this build (git SHA + build time), shared by server and CLI. */
export function getBuildStamp(): string {
  return formatBuildStamp(getBuildInfo());
}
