import type { PortableMcpConfig } from "./portable-mcp";
import type { ResolvedCapabilityCascade } from "./runtime-config";

export interface ConversationToolingOverrides {
  portableMcp?: PortableMcpConfig;
  /**
   * Backend-neutral resolved capability cascade seeded into the runtime at
   * creation. Each backend factory translates it into its provider payload
   * internally (`createRuntime`), so no provider config type crosses this
   * seam.
   */
  capabilities?: ResolvedCapabilityCascade;
}
