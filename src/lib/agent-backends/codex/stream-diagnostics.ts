export function isAdvisoryCodexDiagnostic(message: string): boolean {
  return /^Skill descriptions were shortened to fit the skills context budget\.?$/.test(
    message.trim(),
  );
}
