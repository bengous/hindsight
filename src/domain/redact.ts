const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

const ASSIGNED_SECRET = /\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/** Applied to every text before it reaches a model, a run file or a card; evidence quotes are checked against the result. */
export function redactSecrets(text: string): string {
  const withoutTokens = SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
  return withoutTokens.replace(
    ASSIGNED_SECRET,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
}
