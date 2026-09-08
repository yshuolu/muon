// Extracted from Orca's claude-structured-item-translation.ts.
export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function errorMessage(value: unknown, fallback: string): string {
  return text(record(value)?.message) ?? text(value) ?? fallback;
}
