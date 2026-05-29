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

/** Standard error response */
export function sendError(
  res: Response,
  message: string,
  statusCode = 400,
  errors?: unknown
): void {
  res.status(statusCode).json({
    success: false,
    message,
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
