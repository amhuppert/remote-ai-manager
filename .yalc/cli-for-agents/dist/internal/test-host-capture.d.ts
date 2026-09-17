import type { Host } from "../runtime/index.js";
import type { HostCall } from "../testing/index.js";
/** Wrap capabilities per invocation, so a shared host's history cannot leak into
 * a concurrent run's evidence. Calls retain the original receiver and behavior. */
export declare function captureHost(host: Host, calls: HostCall[]): Host;
//# sourceMappingURL=test-host-capture.d.ts.map