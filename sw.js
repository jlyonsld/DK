// Minimal pass-through service worker. Exists only to satisfy PWA
// installability — every fetch goes straight to the network so Vercel
// redeploys are visible immediately (CLAUDE.md §5).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() =>
      new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    )
  );
});
