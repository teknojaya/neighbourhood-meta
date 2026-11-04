import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { getMessaging } from 'firebase-admin/messaging';
import { FcmPushSender } from './modules/notifications/push.adapter.js';
import { MaintenanceService } from './modules/notifications/maintenance.service.js';
import { GeoapifyPlaces } from './modules/places/geoapify.client.js';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { createStorageBundle } from './lib/storage-bundle.js';
import { AiService } from './modules/ai/ai.service.js';
import { MetaAdapter } from './modules/ai/meta.adapter.js';
import { MetaChatClient } from './modules/ai/meta.client.js';
import { PrismaAccessRepository } from './modules/auth/access.js';
import { FirebaseTokenVerifier } from './modules/auth/auth.js';
import { PrismaUsersRepository, UserProvisioningService } from './modules/auth/users.js';
import { SmtpEmailSender } from './modules/email-otp/email.sender.js';
import { FirebaseIdentityProvider } from './modules/email-otp/firebase-identity.js';
import { PrismaOtpChallengeRepository } from './modules/email-otp/otp.repository.js';
import { EmailOtpService } from './modules/email-otp/otp.service.js';
import { LoansService } from './modules/loans/loans.service.js';
import { CommunitiesService } from './modules/communities/communities.service.js';
import { ListingsService } from './modules/listings/listings.service.js';
import { MatchingService } from './modules/needs/matching.service.js';
import { EventsService } from './modules/events/events.service.js';
import { EventDraftService } from './modules/events/events.ai.js';
import { PrismaProfilesRepository } from './modules/profiles/profiles.repository.js';
import { ProfilesService } from './modules/profiles/profiles.service.js';
import { PrismaRequestsService } from './modules/requests/requests.service.js';
import { PrismaConversationsService } from './modules/conversations/conversations.service.js';
import { PrismaNotificationsService } from './modules/notifications/notifications.service.js';
import { PrismaNeedsService } from './modules/needs/needs.service.js';
import { PrismaAskService } from './modules/ask/ask.service.js';
import { MetaAskModel } from './modules/ask/ask.model.js';

function main() {
  // Safe environment loading for local development
  try {
    process.loadEnvFile('.env');
  } catch {
    try {
      process.loadEnvFile('../../.env');
    } catch {
      // In CI or deployed Cloud Run, variables come from process.env
    }
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Firebase is used for Authentication, Cloud Messaging and Cloud Storage only.
  // On Cloud Run, credentials come from the service account (ADC).
  const firebaseApp = initializeApp({
    ...(config.firebase.projectId ? { projectId: config.firebase.projectId } : {}),
    ...(config.firebase.storageBucket ? { storageBucket: config.firebase.storageBucket } : {}),
  });
  const firebaseAuth = getAuth(firebaseApp);
  const db = createDb(config.databaseUrl!);
  const access = new PrismaAccessRepository(db);

  const metaClient = config.meta ? new MetaChatClient(config.meta.apiKey) : null;
  const generator = config.meta && metaClient ? new MetaAdapter(config.meta.model, metaClient) : null;
  const askModel = config.meta && metaClient ? new MetaAskModel(config.meta.model, metaClient) : null;
  const otp = new EmailOtpService(
    config.emailOtp
      ? {
          secret: config.emailOtp.secret,
          challenges: new PrismaOtpChallengeRepository(db),
          sender: new SmtpEmailSender(config.emailOtp.smtp),
          identity: new FirebaseIdentityProvider(firebaseAuth),
        }
      : null,
    Boolean(config.firebase.projectId),
  );

  const storage = createStorageBundle(config, getStorage(firebaseApp));
  const photoStorage = storage.photos;
  const listings = new ListingsService(db, photoStorage);
  const matching = new MatchingService(db, listings, generator);

  const services = { loans: new LoansService(db, photoStorage), communities: new CommunitiesService(db), needs: new PrismaNeedsService(db), requests: new PrismaRequestsService(db, photoStorage), conversations: new PrismaConversationsService(db, storage.conversations, photoStorage), notifications: new PrismaNotificationsService(db) };
  const askServices = { ...services, marketplace: { listings, loans: services.loans, communities: services.communities, matching }, listings: { get: async (userId: string, id: string) => (await listings.getListingDetail(userId, id)).listing } };
  const ask = new PrismaAskService(db, askModel,
    storage.ask, askServices);
  // Storage cleanup is retryable; soft-deleted chats are never readable meanwhile.
  void ask.purgeDeletedSessions().catch(() => logger.warn('ask_cleanup_unavailable'));
  const cleanup = setInterval(() => { void ask.purgeDeletedSessions().catch(() => logger.warn('ask_cleanup_unavailable')); void services.conversations.cleanupAttachments().catch(() => logger.warn('message_photo_cleanup_unavailable')); }, 15 * 60_000);
  cleanup.unref();
  const maintenance = new MaintenanceService(db, process.env.PUSH_ENABLED === 'true' && !config.firebase.useEmulators ? new FcmPushSender(getMessaging(firebaseApp)) : null);
  const jobs = setInterval(() => { void maintenance.run().catch(() => logger.warn('maintenance_retry_needed')); }, 60_000);
  jobs.unref();
  const app = createApp({
    config,
    db,
    demoSignIn: config.firebase.useEmulators ? async uid => { await firebaseAuth.getUser(uid); return firebaseAuth.createCustomToken(uid); } : undefined,
    tokenVerifier: new FirebaseTokenVerifier(firebaseAuth),
    users: new UserProvisioningService(new PrismaUsersRepository(db)),
    access,
    otp,
    profiles: new ProfilesService(new PrismaProfilesRepository(db), access),
    ai: new AiService(generator, undefined, askModel),
    ...services,
    ask,
    listings,
    matching,
    photoStorage,
    places: config.geoapifyApiKey ? new GeoapifyPlaces(config.geoapifyApiKey) : null,
    events: { service: new EventsService(db), drafts: new EventDraftService(generator) },
  });

  const server = app.listen(config.port, (error) => {
    if (error) {
      logger.error('server_start_failed', { port: config.port, code: (error as NodeJS.ErrnoException).code ?? 'INTERNAL' });
      clearInterval(cleanup); clearInterval(jobs);
      void db.$disconnect().finally(() => process.exit(1));
      return;
    }
    logger.info('server_started', {
      port: config.port,
      env: config.env,
      authEmulator: config.firebase.useEmulators,
      storageDriver: storage.driver,
      aiAvailable: generator !== null,
      aiModel: config.meta?.model ?? null,
      placeSearchAvailable: config.geoapifyApiKey !== null,
      emailOtpAvailable: config.emailOtp !== null,
      // Names only, never values.
      emailOtpMissing: config.emailOtpMissing.join(',') || null,
      servingWeb: Boolean(config.webDistDir),
    });
  });

  const shutdown = (signal: string) => {
    logger.info('server_stopping', { signal });
    clearInterval(cleanup);
    clearInterval(jobs);
    server.close(() => {
      void db.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
