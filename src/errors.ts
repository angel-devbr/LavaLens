export class LavaLensError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'LavaLensError';
  }
}

export function errorBody(error: unknown) {
  if (error instanceof LavaLensError) {
    return { status: error.status, body: { code: error.code, messageKey: `errors.${error.code.toLowerCase()}`, message: error.message, details: error.details } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { code: 'INTERNAL_ERROR', messageKey: 'errors.internal_error', message } };
}
