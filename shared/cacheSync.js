/* ═══════════════════════════════════════════════════════════════
 *  shared/cacheSync.js   —   the Master "cache" button, for every module
 *
 *  Load AFTER cacheWatcher.js and api.js:
 *    <script src=".../shared/cacheWatcher.js?v=1"></script>
 *    <script src=".../shared/api.js?v=1"></script>
 *    <script src=".../shared/cacheSync.js?v=1"></script>
 *
 *  HTML (same in every module):
 *    <button class="ib cache-ind warn" id="cache-ind" type="button" title="Cache: waiting…"><i class="ti ti-database"></i></button>
 *
 *  JS:
 *    const cache = AP2Cache.create({
 *      onRows(rows, manual){ …build your lists from [[ID,Specs,Item,Description,Status],…]… ; return count; },
 *      title: n => 'Cache loaded · ' + n + ' rows',      // optional tooltip text
 *      toast: showToast,                                  // optional (msg, 'error'|'success'|'info')
 *      hasPending: () => bool, onPending: () => sync(),   // optional: don't overwrite unsynced local changes
 *      hasLocalData: () => bool,                          // optional: ignore one flaky empty read
 *      sigKey: 'my_sig_key',                              // optional: remember last applied data across reloads
 *    });
 *    cache.start();
 *
 *  What it does (identical to the working Master behaviour)
 *    • paints instantly from the local IndexedDB cache, then listens to the portal for live updates
 *    • click the button → reload from cache now;  also polls every 4 s as a safety net
 *    • locks editing (body.cache-off) until the cache was read once, so stale data never overwrites the sheet
 *    • colours: green = loaded · amber = waiting / local changes pending · red = error
 *
 *  cache.refresh(manual) · cache.isLoaded() · cache.requireReady() · cache.requestRefresh(force)
 *  cache.setState(state,title) · cache.forgetSig() · cache.key()
 * ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  if (global.AP2Cache) return;

  const IDB_NAME = 'ap2_fleet_cache', IDB_STORE = 'datasets';

  /* safe local fallback if cacheWatcher.js did not load */
  if (typeof global.AP2CacheWatcher === 'undefined') {
    console.warn('[AP2Cache] cacheWatcher.js did not load — using local fallback');
    global.AP2CacheWatcher = (function () {
      let conn = null;
      const open = () => conn ? Promise.resolve(conn) : new Promise((res, rej) => {
        let done = false;
        const req = indexedDB.open(IDB_NAME);
        const t = setTimeout(() => { if (!done) { done = true; rej(new Error('idb-open-timeout')); } }, 2000);
        req.onsuccess = e => { if (!done) { done = true; clearTimeout(t); conn = e.target.result; res(conn); } };
        req.onerror   = e => { if (!done) { done = true; clearTimeout(t); rej(e.target.error); } };
      });
      return {
        init() {}, subscribe() { return () => {}; }, notifyNow() {},
        getStatus() { return { healthy: false, mode: 'local-fallback', lastError: 'cacheWatcher.js not loaded' }; },
        async readKey(key) {
          try {
            const db = await open();
            if (!db.objectStoreNames.contains(IDB_STORE)) return null;
            const rec = await new Promise((res, rej) => {
              const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
              r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
            });
            return (rec && rec.data) ? rec.data : null;
          } catch (e) { return null; }
        }
      };
    })();
  }

  /* the Specs array inside a cache payload ({Specs:[…]}), or null */
  function pickSpecs(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const k = Object.keys(d).find(x => /^specs$/i.test(x) && Array.isArray(d[x]));
    return k ? d[k] : null;
  }
  function idbOpen() {
    return new Promise((res, rej) => {
      let done = false;
      const req = indexedDB.open(IDB_NAME);
      const t = setTimeout(() => { if (!done) { done = true; rej(new Error('idb-open-timeout')); } }, 2500);
      req.onsuccess = e => { if (!done) { done = true; clearTimeout(t); res(e.target.result); } };
      req.onerror   = e => { if (!done) { done = true; clearTimeout(t); rej(e.target.error); } };
    });
  }

  function create(opt) {
    opt = opt || {};
    const pick     = opt.pick || pickSpecs;
    const titleFn  = opt.title || (n => 'Cache loaded · ' + n + ' rows');
    const toast    = opt.toast || (() => {});
    const indId    = opt.indicator || 'cache-ind';
    const pollMs   = opt.pollMs || 4000;
    const lockCls  = opt.lockClass || 'cache-off';
    const st = { loaded: false, busy: false, count: 0, emptyStreak: 0, sig: '', timer: null };
    let KEY = 'ap2_specsData';
    try { KEY = localStorage.getItem('master_cache_key') || KEY; } catch (e) {}
    if (opt.sigKey) { try { st.sig = localStorage.getItem(opt.sigKey) || ''; } catch (e) {} }

    const sigOf = rows => { try { return String(rows.length) + ':' + JSON.stringify(rows); } catch (e) { return ''; } };
    const lock  = () => { if (document.body) document.body.classList.toggle(lockCls, !st.loaded); };

    function setState(state, title) {
      const el = document.getElementById(indId); if (!el) return;
      el.className = 'ib cache-ind ' + state; el.title = title;
    }
    function post(msg) { try { global.parent.postMessage(msg, '*'); } catch (e) {} }
    function requestRefresh(force) { post({ type: 'ap-cache-request', key: KEY, force: !!force }); }

    async function discoverKey() {
      const db = await idbOpen();
      if (!db.objectStoreNames.contains(IDB_STORE)) return null;
      return new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).openCursor();
        r.onsuccess = () => { const c = r.result; if (!c) return res(null); if (c.value && pick(c.value.data)) return res(c.key); c.continue(); };
        r.onerror = () => rej(r.error);
      });
    }
    async function readCache() {
      if (!KEY) KEY = await discoverKey();
      if (!KEY) return null;
      return global.AP2CacheWatcher.readKey(KEY);
    }

    /* true = handled, false = nothing usable in this payload */
    function apply(payload, manual) {
      const rows = pick(payload);
      if (Array.isArray(rows) && !st.loaded) { st.loaded = true; lock(); if (opt.onLoaded) opt.onLoaded(); }
      if (!rows || !rows.length) return false;
      st.emptyStreak = 0;
      if (opt.hasPending && opt.hasPending()) {                         // never overwrite unsynced local changes
        setState('warn', 'Local changes waiting to sync — cache not applied');
        if (opt.onPending) opt.onPending();
        if (manual) toast('Local changes are still syncing', 'info');
        return true;
      }
      const sig = sigOf(rows);
      if (!manual && sig === st.sig) { setState('ok', titleFn(st.count || rows.length)); return true; }   // nothing new
      let n = opt.onRows ? opt.onRows(rows, !!manual) : rows.length;
      if (typeof n !== 'number') n = rows.length;
      st.count = n; st.sig = sig;
      if (opt.sigKey) { try { localStorage.setItem(opt.sigKey, sig); } catch (e) {} }
      setState('ok', titleFn(n) + ' · ' + new Date().toLocaleTimeString('en-GB'));
      if (manual) toast('Loaded ' + n + ' rows from cache', 'success');
      return true;
    }

    async function refresh(manual) {
      if (st.busy) return; st.busy = true;
      if (manual) setState('warn busy', 'Reading cache…');
      try {
        const payload = await readCache();
        if (!apply(payload, manual)) {
          const have = opt.hasLocalData ? opt.hasLocalData() : false;
          if (have && ++st.emptyStreak < 2) { /* ignore a single empty read */ }
          else setState('warn', 'Cache: no Specs data yet' + (have ? ' — showing local data' : ''));
          if (manual) toast('Cache has no Specs data yet', 'error');
        }
      } catch (e) {
        console.warn('[AP2Cache] read failed', e.message); setState('err', 'Cache error: ' + e.message);
        if (manual) toast('Cache read failed', 'error');
      } finally { st.busy = false; }
    }

    function start() {
      lock();
      try { global.AP2CacheWatcher.init(); global.AP2CacheWatcher.subscribe(() => { refresh(); }); }
      catch (e) { console.warn('[AP2Cache] watcher wiring failed, continuing without live updates:', e.message); }
      const btn = document.getElementById(indId);
      if (btn) btn.addEventListener('click', () => refresh(true));
      global.addEventListener('ap-cache-status', e => { if (e.detail && e.detail.healthy === false) setState('err', 'Cache unavailable: ' + (e.detail.lastError || '')); });

      /* portal shell push — fastest path when running inside the app */
      const fromDatasets = ds => {
        if (!ds || typeof ds !== 'object') return;
        const k = KEY && ds[KEY] ? KEY : Object.keys(ds).find(x => pick(ds[x]));
        if (k) { KEY = k; apply(ds[k]); }
      };
      global.addEventListener('message', e => {
        const m = e.data; if (!m) return;
        if (m.type === 'ap-cache-preload' && m.datasets) fromDatasets(m.datasets);
        if (m.type === 'ap-cache-ready' && pick(m.data)) { if (!KEY) KEY = m.key; apply(m.data); }
        if (m.type === 'ap-cache-updated') { if (KEY) requestRefresh(false); refresh(); }
      });
      refresh();                                  // first paint straight from IndexedDB
      if (KEY) requestRefresh(false);             // ask the portal for its copy too
      st.timer = setInterval(refresh, pollMs);    // safety net
    }

    return {
      start, refresh, requestRefresh, setState,
      isLoaded: () => st.loaded,
      key: () => KEY,
      count: () => st.count,
      forgetSig() { st.sig = ''; if (opt.sigKey) { try { localStorage.removeItem(opt.sigKey); } catch (e) {} } },
      requireReady(msg) {
        if (st.loaded) return true;
        toast(msg || 'Cache not loaded yet — please wait before making changes', 'error');
        return false;
      }
    };
  }

  global.AP2Cache = { create, pickSpecs };
})(window);
