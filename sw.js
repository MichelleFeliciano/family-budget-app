/* Lets the app open with no internet. Online, every file comes straight from
   the network (so updates always show up); offline, on a very slow connection,
   or if the site is down, the last saved copy is used. Calls to GitHub's API
   are never touched. */
const CACHE = "family-budget-v1";
const FILES = ["./", "index.html", "help.html", "css/styles.css", "js/calculations.js", "js/storage.js", "js/app.js", "favicon.svg", "icon-192.png", "icon-512.png", "manifest.json"];
// On a weak signal the network can neither work nor fail for a long time. If a
// saved copy exists, give up on the network after this long and show the copy.
const SLOW_NETWORK_MS = 4000;

self.addEventListener("install", (event) => {
  // "reload" skips the browser's own HTTP cache, so a new version is saved whole,
  // never an old file paired with a new one.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(answer(req, event));
});

async function answer(req, event) {
  // Odd addresses like help.html?x=1 are served from the plain page and never saved
  // as copies of their own (they would pile up).
  const plainAddress = new URL(req.url).search === "";
  const saved = () => caches.match(req, { ignoreSearch: true });

  // "no-cache" makes the browser check with the server every time; GitHub Pages
  // otherwise lets it reuse a file for 10 minutes, which can pair a new page with an old script.
  const network = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok && plainAddress) {
      const copy = res.clone();
      const keep = caches.open(CACHE).then((cache) => cache.put(req, copy));
      try { event.waitUntil(keep); } catch (e) { /* already answered; the save still finishes */ }
    }
    return res;
  });

  const hit = await saved();
  if (!hit) {
    // Nothing saved to fall back on: the network is all there is.
    return network.catch(() => (req.mode === "navigate" ? caches.match("index.html") : Response.error()));
  }
  const tooSlow = new Promise((resolve) => setTimeout(() => resolve(null), SLOW_NETWORK_MS));
  const res = await Promise.race([network.catch(() => null), tooSlow]);
  // A good answer wins; slow, failed, or an error page (the site is down): the saved copy.
  return res && res.ok ? res : hit;
}
