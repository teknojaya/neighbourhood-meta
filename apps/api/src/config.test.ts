import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_META_MODEL, loadConfig } from './config.js';

const emu = {
  USE_FIREBASE_EMULATORS: 'true',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIREBASE_PROJECT_ID: 'demo-neighbourhood',
};

describe('config safeguards', () => {
  it('accepts a local emulator setup', () => {
    expect(loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://x', ...emu }).firebase.useEmulators).toBe(true);
  });
  it('refuses emulators in production or on Cloud Run', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ...emu })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'development', K_SERVICE: 'neighbourhood', ...emu })).toThrow(/not allowed/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'real', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    ).toThrow(ConfigError);
  });
  it('refuses emulator hosts without the explicit flag', () => {
    expect(() => loadConfig({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow(/USE_FIREBASE_EMULATORS/);
  });
  it('requires a demo-* project id with emulators', () => {
    expect(() => loadConfig({ ...emu, FIREBASE_PROJECT_ID: 'my-real-project' })).toThrow(/demo-/);
  });
  it('requires DATABASE_URL outside tests', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });
  it('enables email OTP only when SMTP and OTP_SECRET are complete, listing missing names only', () => {
    const partial = loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test', SMTP_PASSWORD: 'pw-secret' });
    expect(partial.emailOtp).toBeNull();
    expect(partial.emailOtpMissing).toEqual(expect.arrayContaining(['OTP_SECRET', 'SMTP_PORT', 'EMAIL_FROM', 'SMTP_USER']));
    expect(JSON.stringify(partial.emailOtpMissing)).not.toContain('pw-secret');
    const full = loadConfig({
      NODE_ENV: 'test', OTP_SECRET: 'x'.repeat(40), SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587',
      SMTP_USER: 'u', SMTP_PASSWORD: 'p', EMAIL_FROM: 'NeighbourHood <no-reply@example.test>',
    });
    expect(full.emailOtp?.smtp.secure).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'test', OTP_SECRET: 'short' })).toThrow(/32/);
  });
  it('reports the AI model as not configured without leaking values', () => {
    const c = loadConfig({ NODE_ENV: 'test', META_MODEL: 'muse-spark-1.3' });
    expect(c.meta).toBeNull();
    expect(c.aiUnavailableReason).toBe('not_configured');
    const ok = loadConfig({ NODE_ENV: 'test', META_API_KEY: 'secret-value', META_MODEL: 'muse-spark-1.2' });
    expect(ok.meta?.model).toBe('muse-spark-1.2');
    expect(loadConfig({ NODE_ENV: 'test', META_API_KEY: 'secret-value' }).meta?.model).toBe(DEFAULT_META_MODEL);
  });
  it('does not echo secret values in validation errors', () => {
    try {
      loadConfig({ META_MODEL: 'NOT A MODEL; secret-abc', META_API_KEY: 'super-secret' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('super-secret');
      expect(String(e)).not.toContain('secret-abc');
    }
  });
});
