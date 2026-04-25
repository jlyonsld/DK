// Minimal pass-through service worker. Exists only to satisfy PWA
// installability — every fetch goes straight to the network so Vercel
// redeploys are visible immediately (CLAUDE.md §5).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  // Don't touch cross-origin requests at all (Supabase API, jsdelivr
  // CDN, fonts, etc.). Letting them fall through to the browser's
  // default fetch keeps real network/CORS errors visible to callers
  // instead of being masked as a fake 503 "Offline".
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Same-origin: pass through. Don't substitute a fake "Offline"
  // response — that hides errors from app code that has its own
  // failure-handling. If the user is genuinely offline the browser's
  // own error will surface naturally.
  e.respondWith(fetch(e.request));
});
