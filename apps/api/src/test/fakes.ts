import type { Membership, PlatformRole } from '@neighbourhood/shared';
import { createApp } from '../app.js';
import { type AppConfig, loadConfig } from '../config.js';
import { AiService } from '../modules/ai/ai.service.js';
import type { StructuredGenerator, StructuredRequest } from '../modules/ai/meta.adapter.js';
import type { AccessRepository } from '../modules/auth/access.js';
import type { TokenVerifier, VerifiedIdentity } from '../modules/auth/auth.js';
import { DuplicateUserError, type UserRecord, type UsersRepository, UserProvisioningService } from '../modules/auth/users.js';
import type { OtpDeps } from '../modules/email-otp/otp.service.js';
import { EmailOtpService } from '../modules/email-otp/otp.service.js';
import type { ProfilesRepository, ProfileUpdate, StoredProfile } from '../modules/profiles/profiles.repository.js';
import { ProfilesService } from '../modules/profiles/profiles.service.js';
import type { RequestsService } from '../modules/requests/requests.service.js';
import type { ConversationsService } from '../modules/conversations/conversations.service.js';
import type { NotificationsService } from '../modules/notifications/notifications.service.js';
import type { NeedsService } from '../modules/needs/needs.service.js';
import { HttpError } from '../lib/http.js';
import type { PlaceProvider } from '../modules/places/geoapify.client.js';

/**
 * Accepts "test-id-token-for-<firebaseUid>[--<provider>]" and rejects everything
 * else. Provider defaults to google.com. Email is <uid>@example.test (verified).
 */
export class FakeVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    const m = /^test-id-token-for-(.+?)(?:--(.+))?$/.exec(token);
    if (!m?.[1]) throw Object.assign(new Error('bad token'), { status: 401 });
    const { HttpError } = await import('../lib/http.js');
    if (m[1] === 'invalid') throw new HttpError('UNAUTHENTICATED', 'Session is invalid or expired');
    return {
      firebaseUid: m[1],
      email: `${m[1]}@example.test`,
      emailVerified: !m[1].startsWith('unverified'),
      signInProvider: m[2] ?? 'google.com',
      name: null,
    };
  }
}
export const bearer = (firebaseUid: string, provider?: string) =>
  `Bearer test-id-token-for-${firebaseUid}${provider ? `--${provider}` : ''}`;
/** Internal user id assigned by InMemoryUsers for a given firebase uid. */
export const userIdFor = (firebaseUid: string) => `u_${firebaseUid}`;

export class InMemoryUsers implements UsersRepository {
  rows: UserRecord[] = [];
  async findByFirebaseUid(firebaseUid: string) {
    return this.rows.find((r) => r.firebaseUid === firebaseUid) ?? null;
  }
  async insert(data: { firebaseUid: string; email: string; displayName: string | null }) {
    if (this.rows.some((r) => r.firebaseUid === data.firebaseUid || r.email === data.email)) {
      throw new DuplicateUserError('duplicate');
    }
    const row = { id: userIdFor(data.firebaseUid), firebaseUid: data.firebaseUid, email: data.email, disabled: false };
    this.rows.push(row);
    return row;
  }
}

export class InMemoryAccess implements AccessRepository {
  roles = new Map<string, PlatformRole[]>();
  memberships: Membership[] = [];
  async getPlatformRoles(userId: string) {
    return this.roles.get(userId) ?? [];
  }
  async getMembership(communityId: string, userId: string) {
    return this.memberships.find((m) => m.communityId === communityId && m.userId === userId) ?? null;
  }
  async listActiveMemberships(userId: string) {
    return this.memberships.filter((m) => m.userId === userId && m.status === 'active');
  }
}

/** Mirrors the users table: a profile row exists once the user is provisioned. */
export class InMemoryProfiles implements ProfilesRepository {
  store = new Map<string, StoredProfile>();
  constructor(private readonly users: InMemoryUsers) {}
  async get(userId: string) {
    const existing = this.store.get(userId);
    if (existing) return existing;
    if (!this.users.rows.some((r) => r.id === userId)) return null;
    return {
      displayName: null,
      areaLabel: null,
      preferredLanguage: 'en' as const,
      homeLocation: null,
      searchRadiusKm: 3 as const,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    };
  }
  async update(userId: string, p: ProfileUpdate) {
    const base = (await this.get(userId))!;
    this.store.set(userId, { ...base, ...p, updatedAt: '2026-10-17T01:00:00.000Z' });
  }
}

export class FakeGenerator implements StructuredGenerator {
  readonly model = 'fake-model';
  calls: StructuredRequest[] = [];
  constructor(public respond: (req: StructuredRequest) => unknown | Promise<unknown>) {}
  async generateJson(req: StructuredRequest) {
    this.calls.push(req);
    return this.respond(req);
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ NODE_ENV: 'test' }), ...overrides };
}

export function buildTestApp(opts: {
  generator?: StructuredGenerator | null; otp?: OtpDeps | null; firebaseConfigured?: boolean;
  requests?: RequestsService; conversations?: ConversationsService; notifications?: NotificationsService;
  needs?: NeedsService; config?: Partial<AppConfig>; places?: PlaceProvider | null;
} = {}) {
  const access = new InMemoryAccess();
  const users = new InMemoryUsers();
  const profilesRepo = new InMemoryProfiles(users);
  const app = createApp({
    config: testConfig(opts.config),
    tokenVerifier: new FakeVerifier(),
    users: new UserProvisioningService(users),
    access,
    otp: new EmailOtpService(opts.otp ?? null, opts.firebaseConfigured ?? true),
    profiles: new ProfilesService(profilesRepo, access),
    ai: new AiService(opts.generator ?? null, () => new Date('2026-10-17T00:00:00Z')),
    requests: opts.requests ?? { create: unavailable, transition: unavailable, get: unavailable, list: unavailable },
    conversations: opts.conversations ?? { get: unavailable, list: unavailable, messages: unavailable, send: unavailable, markRead: unavailable },
    notifications: opts.notifications ?? { list: unavailable, markRead: unavailable, unread: unavailable },
    needs: opts.needs ?? { list: unavailable, save: unavailable, delete: unavailable },
    places: opts.places ?? null,
  });
  return { app, access, users, profilesRepo };
}

async function unavailable(): Promise<never> { throw new HttpError('NOT_IMPLEMENTED', 'No feature fake supplied'); }
