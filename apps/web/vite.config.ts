import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  // Guard: server secrets must never be bundled into the browser build.
  const leaked = Object.keys(env).filter((k) => /GEMINI|META_API|GEOAPIFY|SECRET|SERVICE_ACCOUNT|PRIVATE_KEY/i.test(k));
  if (leaked.length > 0) {
    throw new Error(`Refusing to build: secret-like variables exposed to the client: ${leaked.join(', ')}`);
  }
  // Guard: production bundles must not point at Firebase emulators.
  if (mode === 'production' && env.VITE_USE_FIREBASE_EMULATORS === 'true') {
    throw new Error('Refusing to build for production with VITE_USE_FIREBASE_EMULATORS=true');
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // One coordinated service worker (src/sw.ts) for app-shell caching
        // now and Firebase Cloud Messaging later.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        injectManifest: {
          sourcemap: false,
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        },
        devOptions: { enabled: false },
        manifest: {
          name: 'NeighbourHood',
          short_name: 'NeighbourHood',
          description: 'Donate and lend useful items with your neighbours.',
          lang: 'en',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#fafaf9',
          theme_color: '#166534',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:8080',
        '/healthz': 'http://localhost:8080',
      },
    },
    build: { sourcemap: false },
  };
});
