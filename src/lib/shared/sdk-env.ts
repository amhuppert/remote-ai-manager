/**
 * Prevent nested session detection when CC runs inside Claude Code.
 *
 * Claude Code sets CLAUDECODE in its child process environment.
 * If CC is itself running inside Claude Code, the SDK would detect this
 * and refuse to start, thinking it's a nested invocation.
 *
 * Importing this module performs the deletion as a side effect at
 * module load time.
 */
delete process.env.CLAUDECODE;
