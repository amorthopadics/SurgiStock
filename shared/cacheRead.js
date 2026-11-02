/* ═══════════════════════════════════════════════════════════════
 *  shared/cacheRead.js   —   read module data from the local cache, always
 *
 *  Opening a module never waits for the server:
 *    1. paint from the local cache at once (retries briefly while the cache is still warming up)
 *    2. keep it current — the cache layer refreshes itself, and every change is picked up here
 *       (cache events, tab focus, light local re-check) with no network request
 *    3. only if the cache has nothing at all: one cache-first load through the data layer
 *       (it contacts the server only when it must)
 *    4. after the user's OWN save: refreshFromServer() asks the data layer to update the cache once,
 *       then the page re-reads it — if that fails (offline) the cached data simply stays on screen
 *
 *  Load after cacheWatcher.js / dataLayer.js, before the page script:
 *    <script src=".../shared/cacheRead.js?v=1"></script>
 *
 *    const feed = AP2Read.watch('ap2_orders', {
 *      pick   : d => d && Array.isArray(d.Orders) ? d : null,   // shape check — null = "nothing usable"
 *      onData : (d, meta) => { …render… },                      // first paint + every later change
 *      apiType: 'orders'                                        // last-resort name for a direct read
 *    });
 *    feed.read()                  // re-read the local cache now (no network)
 *    feed.refreshFromServer()     // after our own write: update the cache once, then re-read
 * ═══════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';
  if (g.AP2Read) return;

  var DELAYS = [300, 500, 800, 1200, 2000, 3000];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function hash(o) {                                   // cheap content fingerprint (change detection only)
    var s; try { s = JSON.stringify(o); } catch (e) { return String(Math.random()); }
    var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ':' + h;
  }

  function watch(key, opt) {
    opt = opt || {};
    var pick = typeof opt.pick === 'function' ? opt.pick : function (d) { return d; };
    var st = { fp: '', painted: false, started: false };

    function deliver(d, meta) {
      var fp = hash(d);
      if (st.painted && fp === st.fp && !(meta && meta.forced)) return true;     // nothing new
      st.fp = fp; st.painted = true;
      try { opt.onData(d, meta || {}); } catch (e) { console.warn('[AP2Read]', key, e); }
      return true;
    }
    async function readNow(meta) {                                               // local cache only
      var d = null;
      try { if (g.AP2CacheWatcher && AP2CacheWatcher.readKey) d = await AP2CacheWatcher.readKey(key); } catch (e) {}
      d = pick(d);
      return d ? deliver(d, meta) : false;
    }
    async function lastResort() {                                                // cache has nothing at all
      var d = null;
      try { if (g.AdminPro && AdminPro.get) d = pick(await AdminPro.get(key)); } catch (e) {}   // cache-first inside
      if (!d && opt.apiType && g.AP2Api && AP2Api.get) { try { d = pick(await AP2Api.get(opt.apiType)); } catch (e) {} }
      return d ? deliver(d, { source: 'direct' }) : false;
    }
    async function boot() {
      for (var i = 0; ; i++) {
        if (await readNow()) return true;
        if (i >= DELAYS.length) break;
        await sleep(DELAYS[i]);
      }
      return lastResort();
    }
    async function refreshFromServer() {
      try {
        if (g.AdminPro && typeof AdminPro.forceRefresh === 'function') await AdminPro.forceRefresh(key);
        else if (g.AdminPro && AdminPro.get) await AdminPro.get(key, true);
      } catch (e) { /* offline / refused → keep showing what is cached */ }
      try { if (g.parent && g.parent !== g) g.parent.postMessage({ type: 'ap-cache-request', key: key, force: true }, '*'); } catch (e) {}
      return readNow({ forced: true });
    }

    function start() {
      if (st.started) return; st.started = true;
      try {
        if (g.AP2CacheWatcher) {
          if (AP2CacheWatcher.init) AP2CacheWatcher.init();
          if (AP2CacheWatcher.subscribe) AP2CacheWatcher.subscribe(function (k) {
            var kk = (k && k.key) || k; if (!kk || kk === key) readNow();
          });
        }
      } catch (e) {}
      g.addEventListener('message', function (e) {
        var t = e && e.data && e.data.type;
        if (t && /^ap-cache/.test(t)) setTimeout(readNow, 250);
      });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) readNow(); });
      setInterval(function () { if (!document.hidden) readNow(); }, 20000);      // local re-check only
      boot();
    }

    var api = { key: key, start: start, read: function () { return readNow(); }, refreshFromServer: refreshFromServer, painted: function () { return st.painted; } };
    start();
    return api;
  }

  g.AP2Read = { watch: watch };
})(window);
