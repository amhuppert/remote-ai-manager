import type { CcHostSource } from "./host-source";
import { ccCommands } from "./family";

export const doctorSpec = {
  path: "doctor",
  summary: "Check connectivity, identity, and build parity",
  description:
    "Diagnose the selected Command Center server, its published binary, and the current identity and credential source.",
  requires: "none",
  effects: "read",
  args: [],
  flags: {},
} as const;

export function createDoctorCommand(host: CcHostSource) {
  return ccCommands.defineCommand(doctorSpec, {
    examples: [{ why: "Diagnose the selected Command Center instance" }],
    handler: async () => ({
      default: (await import("./doctor.handler")).createDoctorHandler(host),
    }),
  });
}
