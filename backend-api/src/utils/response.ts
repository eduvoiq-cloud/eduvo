import { Response } from 'express';

/** Standard success response */
export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode = 200
): void {
  res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

/**
 * Standard error response.
 * In production, raw database/internal error messages are scrubbed for
 * 5xx responses to prevent schema/column name leakage to clients.
 */
export function sendError(
  res: Response,
  message: string,
  statusCode = 400,
  errors?: unknown
): void {
  const isServerError = statusCode >= 500;
  const safeMessage =
    isServerError && process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred. Please try again later.'
      : message;

  res.status(statusCode).json({
    success: false,
    message: safeMessage,
    ...(errors !== undefined && { errors }),
  });
}

/**
 * Database/internal error response.
 *
 * Logs the raw error detail to the server console (for Sentry/Railway logs)
 * and always sends a generic message to the client — even in development —
 * to prevent DB schema, column names, or constraint names from leaking.
 *
 * Use this instead of `sendError(res, error.message, 500)` in route handlers.
 */
export function sendDbError(
  res: Response,
  err: { message: string } | unknown,
  context?: string
): void {
  const detail = err instanceof Error
    ? err.message
    : (err as { message?: string })?.message ?? String(err);

  console.error(`[db-error]${context ? ` [${context}]` : ''} ${detail}`);

  res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
  });
}

/** Validation error response (422) */
export function sendValidationError(res: Response, errors: unknown): void {
  res.status(422).json({
    success: false,
    message: 'Validation failed',
    errors,
  });
}
