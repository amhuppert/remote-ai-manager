import { execFileSync } from "node:child_process";

/**
 * The words a POSIX shell parses a command line into.
 *
 * For asserting on a command string the CLI tells a human or an agent to RUN —
 * a reveal command, a continuation command, a retry hint. Such a string is only
 * correct if the shell reconstructs the exact arguments it was built from, and
 * the failure mode is quiet: a project or session name carrying `$`, a backtick,
 * or a space expands into a different command that succeeds against the wrong
 * target rather than failing.
 *
 * Delegates to the real `/bin/sh` rather than reimplementing the grammar: a
 * hand-written splitter would encode the same assumptions as whatever quoting it
 * was written beside, and agree with its bugs. `set --` applies the shell's own
 * expansion and quote removal to the literal text, so anything that survives
 * here survives in the caller's terminal. The environment is trimmed to `PATH`
 * so an expansion that does leak fails visibly instead of picking up an ambient
 * value that happens to make the assertion pass.
 */
export function shellWords(command: string): string[] {
  const script = `set -- ${command}\nfor arg in "$@"; do printf '%s\\0' "$arg"; done`;
  const output = execFileSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV },
  });
  // Trailing empty segment after the last NUL terminator.
  return output.split("\0").slice(0, -1);
}
