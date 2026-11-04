import { type FirebaseApp, initializeApp } from 'firebase/app';
import { type Auth, connectAuthEmulator, getAuth } from 'firebase/auth';

/**
 * Browser Firebase config. These values are public identifiers, not secrets
 * (access is enforced by the API + security rules). Server secrets such as
 * META_API_KEY must never be exposed via VITE_ variables.
 */
export const firebasePublicConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const config = firebasePublicConfig;
export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.authDomain);

const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
/** Emulators only in dev builds served from localhost. Production builds refuse the flag (vite.config.ts). */
export const usingAuthEmulator = import.meta.env.DEV && isLocalHost && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseAuth(): Auth | null {
  if (!firebaseConfigured) return null;
  if (!auth) {
    app = initializeApp(config);
    auth = getAuth(app);
    if (usingAuthEmulator) {
      connectAuthEmulator(auth, import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL ?? 'http://127.0.0.1:9099', {
        disableWarnings: true,
      });
    }
  }
  return auth;
}
export function getFirebaseApp(): FirebaseApp | null { getFirebaseAuth(); return app; }
