import path from 'node:path';
import express, { type Express, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { API_PREFIX, ApiRoutes } from '@neighbourhood/shared';
import type { LoansService } from './modules/loans/loans.service.js';
import type { CommunitiesService } from './modules/communities/communities.service.js';
import type { MatchingService } from './modules/needs/matching.service.js';
import { pushRouter } from './modules/notifications/push.routes.js';
import type { Db } from './lib/db.js';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { errorHandler, HttpError, notFound, parseBody } from './lib/http.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import type { AiService } from './modules/ai/ai.service.js';
import type { AccessRepository } from './modules/auth/access.js';
import { requireAuth, type TokenVerifier, type UserResolver } from './modules/auth/auth.js';
import { communitiesRouter } from './modules/communities/communities.routes.js';
import { authPublicRouter } from './modules/email-otp/otp.routes.js';
import type { EmailOtpService } from './modules/email-otp/otp.service.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { listingsRouter } from './modules/listings/listings.routes.js';
import { savedItemsRouter } from './modules/listings/saved-items.routes.js';
import { loansRouter } from './modules/loans/loans.routes.js';
import { needsRouter } from './modules/needs/needs.routes.js';
import type { NeedsService } from './modules/needs/needs.service.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { profilesRouter } from './modules/profiles/profiles.routes.js';
import type { PlaceProvider } from './modules/places/geoapify.client.js';
import { placesRouter } from './modules/places/places.routes.js';
import type { ProfilesService } from './modules/profiles/profiles.service.js';
import { requestsRouter } from './modules/requests/requests.routes.js';
import type { RequestsService } from './modules/requests/requests.service.js';
import type { ConversationsService } from './modules/conversations/conversations.service.js';
import type { NotificationsService } from './modules/notifications/notifications.service.js';
import { askRouter } from './modules/ask/ask.routes.js';
import type { AskService } from './modules/ask/ask.service.js';
import type { ListingsService } from './modules/listings/listings.service.js';
import { storageReadRouter } from './modules/storage/storage.routes.js';
import type { VerifiableObjectStorage } from './lib/storage.js';

export interface AppDeps {
  config: AppConfig;
  tokenVerifier: TokenVerifier;
  users: UserResolver;
  access: AccessRepository;
  otp: EmailOtpService;
  profiles: ProfilesService;
  ai: AiService;
  matching?: MatchingService;
  db?: Db;
  demoSignIn?: (uid: 'demo-owner' | 'demo-neighbour' | 'demo-volunteer' | 'demo-moderator' | 'demo-newcomer') => Promise<string>;
  requests: RequestsService;
  conversations: ConversationsService;
  notifications: NotificationsService;
  needs: NeedsService;
  loans?: LoansService;
  communities?: CommunitiesService;
  ask?: AskService;
  listings?: ListingsService;
  photoStorage?: VerifiableObjectStorage;
  places?: PlaceProvider | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxyHops);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // apis.google.com: Firebase Auth helper for Google sign-in (popup/redirect).
          scriptSrc: ["'self'", 'https://apis.google.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://firebasestorage.googleapis.com', 'https://storage.googleapis.com', 'https://tile.openstreetmap.org'],
          connectSrc: [
            "'self'",
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://firebaseinstallations.googleapis.com',
            'https://fcmregistrations.googleapis.com',
            'https://fcm.googleapis.com',
            'https://www.googleapis.com',
            'https://firebasestorage.googleapis.com',
            // V4 signed upload URLs for images.
            'https://storage.googleapis.com',
          ],
          // Firebase Auth handler iframe on the authDomain.
          frameSrc: ["'self'", 'https://*.firebaseapp.com', 'https://*.web.app', 'https://accounts.google.com'],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          // Only when deployed behind HTTPS; local http://localhost testing would break otherwise.
          upgradeInsecureRequests: deps.config.deployed ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      // Firebase signInWithPopup must keep its opener link; helmet's default
      // 'same-origin' breaks Google sign-in on the deployed origin.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );

  // Liveness/readiness for Cloud Run. No dependencies, no secrets.
  app.get(ApiRoutes.health, (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ------------------------------------------------------------------- API
  const api = Router();
  api.use((_req, res, next) => {
    // Authenticated data must never be cached by browsers, proxies or the SW.
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new HttpError('RATE_LIMITED', 'Too many requests')),
    }),
  );
  api.use(express.json({ limit: '32kb' }));
  // Public sign-in support (auth methods, email OTP → Firebase custom token).
  api.use(authPublicRouter(deps.otp));
  if (deps.config.firebase.useEmulators && deps.demoSignIn) api.post('/auth/demo', async (req, res) => { const body = parseBody(z.strictObject({ uid: z.enum(['demo-owner', 'demo-neighbour', 'demo-volunteer', 'demo-moderator', 'demo-newcomer']) }), req); res.json({ customToken: await deps.demoSignIn!(body.uid) }); });
  if (deps.communities) api.get('/points/qr-image/:qrId', async (req, res) => {
    const qrId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).parse(req.params.qrId);
    await deps.communities!.qr(qrId);
    res.type('image/png').send(await QRCode.toBuffer(qrId, { width: 240, margin: 4, errorCorrectionLevel: 'M' }));
  });
  // Local storage routes (unauthenticated to mirror S3/GCS signed URL behavior)
  if (deps.photoStorage) {
    api.use(storageReadRouter(deps.photoStorage));
  }
  // Every other /api/v1 route requires a verified Firebase ID token mapped to a PostgreSQL user.
  api.use(requireAuth(deps.tokenVerifier, deps.users));

  api.use(profilesRouter(deps.profiles));
  api.use(placesRouter(deps.places ?? null));
  api.use(aiRouter(deps.ai, { matching: deps.matching, photo: deps.ask ? (userId, sessionId, attachmentId) => deps.ask!.image(userId, sessionId, attachmentId) : undefined }));
  if (deps.ask) api.use(askRouter(deps.ask));
  api.use(listingsRouter(deps.listings));
  if (deps.db && deps.listings) api.use(savedItemsRouter(deps.db, deps.listings));
  api.use(communitiesRouter(deps.communities));
  api.use(requestsRouter(deps.requests));
  api.use(loansRouter(deps.loans));
  api.use(needsRouter(deps.needs, deps.matching));
  api.use(conversationsRouter(deps.conversations));
  api.use(notificationsRouter(deps.notifications));
  if (deps.db) api.use(pushRouter(deps.db));
  api.use(notFound);

  app.use(API_PREFIX, api);

  // -------------------------------------------------------- Static frontend
  if (deps.config.webDistDir) {
    const dist = path.resolve(deps.config.webDistDir);
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, filePath) => {
          const base = path.basename(filePath);
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (base === 'sw.js' || base === 'manifest.webmanifest' || base.endsWith('.html')) {
            res.set('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    // SPA fallback for client-side routes. A missing file (e.g. a hashed chunk
    // from a previous release) must 404, not return HTML the browser can't run.
    app.get(/^\/(?!api\/).*/, (req, res, next) => {
      if (req.path.startsWith('/assets/') || path.extname(req.path)) return next();
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
