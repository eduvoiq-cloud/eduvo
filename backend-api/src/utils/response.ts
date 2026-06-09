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

/** Validation error response (422) */
export function sendValidationError(res: Response, errors: unknown): void {
  res.status(422).json({
    success: false,
    message: 'Validation failed',
    errors,
  });
}
