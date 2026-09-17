import type { Host } from "../runtime/index.js";
import type { ArtifactManifest, ResolvedArtifactPolicy } from "../disclosure.js";
export declare function retentionMetadataName(name: string): boolean;
/** User-approved opt-in sweep: direct managed children only, never recursive. */
export declare function expireArtifacts(policy: ResolvedArtifactPolicy, host: Host, signal: AbortSignal, keep: string): Promise<void>;
/** Protect automatic-looking explicit paths before writing them; never expire --out. */
export declare function protectExplicit(path: string, policy: ResolvedArtifactPolicy, host: Host): Promise<void>;
export declare function trackArtifact(manifest: ArtifactManifest, policy: ResolvedArtifactPolicy, host: Host, signal: AbortSignal): Promise<void>;
//# sourceMappingURL=artifact-retention.d.ts.map