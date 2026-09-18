import { describe, expect, it } from "vitest";
import { resolveVerifiedDevProbeTarget, verifyDevProbeTarget } from "./routes";

const envelope = (data: unknown) => ({
  ok: true,
  effect: "read",
  payload: { kind: "inline", data },
  reminders: [],
  issues: [],
});

const worktree = "/scratch/lane";
const doctor = {
  sameInstance: false,
  managing: { server: "http://localhost:3000", configDir: "/live" },
  dev: {
    server: "http://localhost:3003",
    configDir: `${worktree}/.config`,
    worktreePath: worktree,
  },
};

describe("authenticated handoff route target", () => {
  it("adopts a doctor-verified running target after an ensure failure", () => {
    const commands: string[][] = [];
    const target = resolveVerifiedDevProbeTarget(worktree, (args) => {
      commands.push([...args]);
      if (args[1] === "ensure") throw new Error("private transport details");
      return JSON.stringify(envelope(doctor));
    });
    expect(commands.map((args) => args[1])).toEqual(["ensure", "doctor"]);
    expect(target).toEqual({
      server: doctor.dev.server,
      configDir: doctor.dev.configDir,
      startFailureCode: "cctl_dev_ensure_failed",
    });
    expect(JSON.stringify(target)).not.toContain("private transport details");
  });

  it("does not adopt another worktree after an ensure failure", () => {
    expect(() =>
      resolveVerifiedDevProbeTarget(worktree, (args) => {
        if (args[1] === "ensure") throw new Error("failed start");
        return JSON.stringify(
          envelope({
            ...doctor,
            dev: { ...doctor.dev, worktreePath: "/another/lane" },
          }),
        );
      }),
    ).toThrow(/refused/);
  });

  it("does not adopt an unverified target after both commands fail", () => {
    expect(() =>
      resolveVerifiedDevProbeTarget(worktree, () => {
        throw new Error("failed command");
      }),
    ).toThrow(/failed command/);
  });

  it("accepts only the doctor-verified worktree datastore", () => {
    expect(verifyDevProbeTarget(envelope(doctor), worktree)).toEqual({
      server: doctor.dev.server,
      configDir: doctor.dev.configDir,
    });
  });
  it("refuses stale flat doctor output", () => {
    expect(() =>
      verifyDevProbeTarget({ ok: true, ...doctor }, worktree),
    ).toThrow(/refused/);
  });
  it.each([
    { ...doctor, sameInstance: true },
    { ...doctor, dev: { ...doctor.dev, configDir: "/live" } },
    { ...doctor, dev: { ...doctor.dev, worktreePath: "/another/lane" } },
    { ...doctor, dev: { ...doctor.dev, server: doctor.managing.server } },
    { ...doctor, dev: { ...doctor.dev, configDir: `${worktree}/../other` } },
  ])("refuses managing or neighboring state before authentication", (input) => {
    expect(() => verifyDevProbeTarget(envelope(input), worktree)).toThrow(
      /refused/,
    );
  });
});
