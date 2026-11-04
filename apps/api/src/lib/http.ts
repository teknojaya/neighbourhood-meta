import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { type ApiErrorBody, type ApiErrorCode, DomainError } from '@neighbourhood/shared';
import { logger } from './logger.js';

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  INSUFFICIENT_STOCK: 409,
  SELF_REQUEST: 403,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  NOT_IMPLEMENTED: 501,
  AUTH_NOT_CONFIGURED: 503,
  STORAGE_UNAVAILABLE: 503,
  UNSUPPORTED_SIGN_IN_METHOD: 403,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_LINK_REQUIRED: 409,
  ACCOUNT_DISABLED: 403,
  OTP_NOT_CONFIGURED: 503,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_TOO_MANY_ATTEMPTS: 429,
  OTP_RESEND_TOO_SOON: 429,
  EMAIL_DELIVERY_FAILED: 502,
  AI_NOT_CONFIGURED: 503,
  AI_MODEL_UNAVAILABLE: 503,
  AI_QUOTA_EXCEEDED: 429,
  AI_TIMEOUT: 504,
  AI_INVALID_OUTPUT: 502,
  AI_INPUT_REJECTED: 422,
  AI_UPSTREAM_ERROR: 502,
  GEOCODING_NOT_CONFIGURED: 503,
  GEOCODING_UNAVAILABLE: 502,
  INTERNAL: 500,
};

export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = STATUS[code];
  }
}

export const notFound: RequestHandler = (_req, _res, next) => next(new HttpError('NOT_FOUND', 'Route not found'));

export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  return parseWith(schema, req.body);
}

export function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  return parseWith(schema, req.query);
}

function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let httpErr: HttpError;
  if (err instanceof HttpError) httpErr = err;
  else if (err instanceof DomainError) httpErr = new HttpError(err.code, err.message);
  else if (isBodyParserError(err)) {
    httpErr =
      err.type === 'entity.too.large'
        ? new HttpError('PAYLOAD_TOO_LARGE', 'Request body too large')
        : new HttpError('BAD_REQUEST', 'Malformed request body');
  } else {
    logger.error('unhandled_error', {
      requestId: req.get('x-cloud-trace-context') ?? undefined,
      path: req.path,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    httpErr = new HttpError('INTERNAL', 'Something went wrong');
  }
  const body: ApiErrorBody = {
    error: { code: httpErr.code, message: httpErr.message, ...(httpErr.details ? { details: httpErr.details } : {}) },
  };
  // A streamed response cannot switch back to a JSON error body mid-flight.
  if (res.headersSent) { res.end(); return; }
  res.status(httpErr.status).json(body);
};

function isBodyParserError(err: unknown): err is { type: string } {
  return typeof err === 'object' && err !== null && 'type' in err && typeof (err as { type: unknown }).type === 'string';
}

/** Marks a planned endpoint that a module owner has not implemented yet. */
export const notImplemented =
  (feature: string): RequestHandler =>
  () => {
    throw new HttpError('NOT_IMPLEMENTED', `${feature} is not implemented yet`);
  };
