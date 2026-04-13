export type PortableMcpServerConfig =
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      enabled?: boolean;
      enabledTools?: string[];
      disabledTools?: string[];
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | {
      id: string;
      transport: "streamable-http";
      url: string;
      headers?: Record<string, string>;
      bearerTokenEnvVar?: string;
      enabled?: boolean;
      enabledTools?: string[];
      disabledTools?: string[];
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    };

export interface PortableMcpConfig {
  servers: PortableMcpServerConfig[];
}

export interface McpApplyResult {
  disposition:
    | "applied_now"
    | "deferred_to_next_turn"
    | "unsupported"
    | "rejected";
  droppedServerIds: string[];
  droppedFields: string[];
  errors: Record<string, string>;
}
