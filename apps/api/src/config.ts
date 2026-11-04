import { z } from 'zod';

/**
 * Environment configuration. Validated once at startup; the process refuses
 * to start on unsafe combinations (e.g. emulators in production).
 */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Set automatically by Cloud Run. Its presence means "deployed". */
  K_SERVICE: z.string().optional(),

  /** PostgreSQL connection string (Cloud SQL via unix socket in production). */
  DATABASE_URL: optionalString,
  /** Connections per process; Cloud SQL caps the total across instances and jobs. */
  DATABASE_POOL_MAX: optionalString.pipe(z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/, 'DATABASE_POOL_MAX must be an integer from 1 to 100').optional()),

  FIREBASE_PROJECT_ID: optionalString,
  FIREBASE_STORAGE_BUCKET: optionalString,
  STORAGE_SIGNING_SECRET: optionalString,

  /** Must be exactly "true" to allow any *_EMULATOR_HOST variable. */
  USE_FIREBASE_EMULATORS: z.enum(['true', 'false']).default('false'),
  FIREBASE_AUTH_EMULATOR_HOST: optionalString,
  FIREBASE_STORAGE_EMULATOR_HOST: optionalString,

  /** Meta Model API key (server-side only). */
  META_API_KEY: optionalString,
  META_MODEL: optionalString.pipe(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,80}$/, 'META_MODEL must be a model id like muse-spark-1.3')
      .optional(),
  ),

  /** HMAC key for email OTP codes (≥ 32 chars). */
  OTP_SECRET: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalString.pipe(z.string().regex(/^\d{1,5}$/, 'SMTP_PORT must be a port number').optional()),
  /** "true" = implicit TLS (port 465); "false" = STARTTLS required (587). */
  SMTP_SECURE: optionalString.pipe(z.enum(['true', 'false']).optional()),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  /** e.g. "NeighbourHood <no-reply@your-domain>" — must be a sender your SMTP relay allows. */
  EMAIL_FROM: optionalString,

  /** Path to the built frontend served in production. */
  WEB_DIST_DIR: optionalString,
  /** Number of trusted reverse proxies (Cloud Run front end = 1). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
});

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  deployed: boolean;
  databaseUrl: string | undefined;
  firebase: { projectId: string | undefined; storageBucket: string | undefined; useEmulators: boolean };
  meta: { apiKey: string; model: string } | null;
  /** Why the AI model is unavailable; shown as an honest state in the UI. */
  aiUnavailableReason: 'not_configured' | null;
  /** Null when OTP email delivery is not fully configured. */
  emailOtp: { secret: string; smtp: SmtpConfig } | null;
  emailOtpMissing: string[];
  webDistDir: string | undefined;
  trustProxyHops: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** From https://dev.meta.ai/docs/models (verified 2026-11-04). */
export const DEFAULT_META_MODEL = 'muse-spark-1.3';

const EMULATOR_VARS = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'] as const;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // Only report variable names and messages — never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  const deployed = Boolean(e.K_SERVICE);
  const useEmulators = e.USE_FIREBASE_EMULATORS === 'true';
  const emulatorVarsSet = EMULATOR_VARS.filter((k) => Boolean(e[k]));

  // --- Production safeguards ---------------------------------------------
  // The Admin SDK accepts unsigned ID tokens when FIREBASE_AUTH_EMULATOR_HOST
  // is set. That must never happen outside local development.
  if ((e.NODE_ENV === 'production' || deployed) && (useEmulators || emulatorVarsSet.length > 0)) {
    throw new ConfigError(
      `Firebase emulators are not allowed in production/Cloud Run (found: ${[
        ...(useEmulators ? ['USE_FIREBASE_EMULATORS'] : []),
        ...emulatorVarsSet,
      ].join(', ')})`,
    );
  }
  if (!useEmulators && emulatorVarsSet.length > 0) {
    throw new ConfigError(
      `${emulatorVarsSet.join(', ')} set without USE_FIREBASE_EMULATORS=true. Refusing to start with an ambiguous auth setup.`,
    );
  }
  if (useEmulators && !e.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new ConfigError('USE_FIREBASE_EMULATORS=true requires FIREBASE_AUTH_EMULATOR_HOST');
  }
  if (useEmulators && e.FIREBASE_PROJECT_ID && !e.FIREBASE_PROJECT_ID.startsWith('demo-')) {
    throw new ConfigError('With emulators, FIREBASE_PROJECT_ID must be a demo-* project to avoid touching real resources');
  }
  if (e.NODE_ENV === 'production' && !e.FIREBASE_PROJECT_ID) {
    throw new ConfigError('FIREBASE_PROJECT_ID is required in production');
  }
  if ((e.NODE_ENV === 'production' || deployed) && e.FIREBASE_STORAGE_BUCKET && (!e.STORAGE_SIGNING_SECRET || e.STORAGE_SIGNING_SECRET.length < 32)) throw new ConfigError('STORAGE_SIGNING_SECRET must contain at least 32 characters for deployed photo links');
  if (e.NODE_ENV !== 'test' && !e.DATABASE_URL) {
    throw new ConfigError('DATABASE_URL is required (see apps/api/.env.example)');
  }

  const meta = e.META_API_KEY ? { apiKey: e.META_API_KEY, model: e.META_MODEL ?? DEFAULT_META_MODEL } : null;

  // --- Email OTP ----------------------------------------------------------
  const missing: string[] = [];
  if (!e.OTP_SECRET) missing.push('OTP_SECRET');
  else if (e.OTP_SECRET.length < 32) throw new ConfigError('OTP_SECRET must be at least 32 characters');
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'EMAIL_FROM'] as const) if (!e[k]) missing.push(k);
  if (Boolean(e.SMTP_USER) !== Boolean(e.SMTP_PASSWORD)) missing.push(e.SMTP_USER ? 'SMTP_PASSWORD' : 'SMTP_USER');
  const emailOtp =
    missing.length === 0
      ? {
          secret: e.OTP_SECRET!,
          smtp: {
            host: e.SMTP_HOST!,
            port: Number(e.SMTP_PORT),
            secure: e.SMTP_SECURE === 'true' || (e.SMTP_SECURE === undefined && e.SMTP_PORT === '465'),
            user: e.SMTP_USER,
            password: e.SMTP_PASSWORD,
            from: e.EMAIL_FROM!,
          },
        }
      : null;

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    deployed,
    databaseUrl: e.DATABASE_URL,
    firebase: { projectId: e.FIREBASE_PROJECT_ID, storageBucket: e.FIREBASE_STORAGE_BUCKET, useEmulators },
    meta,
    aiUnavailableReason: meta ? null : 'not_configured',
    emailOtp,
    emailOtpMissing: missing,
    webDistDir: e.WEB_DIST_DIR,
    trustProxyHops: e.TRUST_PROXY_HOPS,
  };
}
