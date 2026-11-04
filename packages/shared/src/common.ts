import { z } from 'zod';

/** Resource identifier (UUID from PostgreSQL, or a URL-safe slug). */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier');
export type Id = z.infer<typeof IdSchema>;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const IsoDateSchema = z.iso.date();

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLngSchema>;

/**
 * Public, deliberately imprecise location. Never derived by clients from
 * exact coordinates; produced server-side by `approximateLocation()`.
 */
export const ApproximateLocationSchema = z.object({
  /** Coordinates rounded to ~1 km precision. */
  approxLat: z.number(),
  approxLng: z.number(),
  /** Human label chosen by the owner, e.g. "Kemang, South Jakarta". */
  areaLabel: z.string().max(120),
  /** Straight-line distance from the searcher, rounded up to 0.5 km steps. */
  distanceKm: z.number().nonnegative().optional(),
});
export type ApproximateLocation = z.infer<typeof ApproximateLocationSchema>;

export const ApiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
  'INSUFFICIENT_STOCK',
  'SELF_REQUEST',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'NOT_IMPLEMENTED',
  'AUTH_NOT_CONFIGURED',
  'STORAGE_UNAVAILABLE',
  'UNSUPPORTED_SIGN_IN_METHOD',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_LINK_REQUIRED',
  'ACCOUNT_DISABLED',
  'OTP_NOT_CONFIGURED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_TOO_MANY_ATTEMPTS',
  'OTP_RESEND_TOO_SOON',
  'EMAIL_DELIVERY_FAILED',
  'AI_NOT_CONFIGURED',
  'AI_MODEL_UNAVAILABLE',
  'AI_QUOTA_EXCEEDED',
  'AI_TIMEOUT',
  'AI_INVALID_OUTPUT',
  'AI_INPUT_REJECTED',
  'AI_UPSTREAM_ERROR',
  'GEOCODING_NOT_CONFIGURED',
  'GEOCODING_UNAVAILABLE',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    /** Field-level validation issues; never contains secrets or private text. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const PageQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/**
 * Header required on every state-changing endpoint that creates a resource
 * or performs a transition. The server stores the key with the result and
 * replays the stored result on retry.
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
