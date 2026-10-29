/*!
 * shared/offlineSync.js  —  AP2Sync
 * Offline-first "save locally now, sync to backend when possible" for every module.
 *
 * HOW IT WORKS
 *   1. Your module saves into its own in-memory data + localStorage (instant, works offline).
 *   2. Your module calls  sync.sync()  — it compares what the module has now with a snapshot of
 *      what the backend last confirmed, and sends ONLY the difference (add / update / delete).
 *   3. No network or server trouble → nothing is lost: the change stays pending, a small icon shows
 *      the pending count, and it is retried when the browser comes back online and every N seconds.
 *   4. Pending state is DERIVED from (current data vs snapshot), so it can never drift or be lost
 *      on reload. Retrying is always safe.
 *
 * LOAD (after api.js):
 *   <script src="https://amorthopadics.github.io/SurgiStock/shared/offlineSync.js?v=1"></script>
 *
 * MINIMAL USE
 *   const sync = AP2Sync.create({
 *     key        : 'purchase',                       // unique per module (prefixes localStorage keys)
 *     indicator  : 'sync-ind',                       // optional: id of the cloud button (see markup below)
 *     getCurrent : () => ({ [id]: [col1, col2, …], … }),   // EVERY row the backend should have, keyed by id
 *     actions    : { add:'addPurchase', update:'updatePurchase', remove:'deletePurchase' },
 *     toast      : (msg, type) => showToast(msg, type)
 *   });
 *   sync.start();                                    // once, at init
 *   // …in every save / edit / delete / toggle / import handler:
 *   persist(); render(); sync.sync();               // local first, then background sync
 *
 * INDICATOR MARKUP (optional)
 *   <button id="sync-ind" style="display:none"><i class="ti ti-cloud-upload"></i><b class="sync-n">0</b></button>
 *   (gets class "busy" while sending; hidden when nothing is pending)
 *
 * ALL OPTIONS
 *   key, getCurrent, actions                      required (see above)
 *   post(action, payload) → Promise<json>         default AP2Api.post
 *   rowOut(row)            → what is sent per row (default: row as is)
 *   idOut(id)              → what is sent per deleted id (default: id as is)
 *   rowsPayload(rows)      → body for add/update   default { rows }
 *   idsPayload(ids)        → body for delete       default { ids }
 *   onAdded(resp, adds, next) → handle the server's reply to "add" (e.g. it re-numbered ids).
 *                             adds = [[id,row],…] ; you MUST write the confirmed rows into `next`
 *                             (next[id] = row). Return true if you changed your data (it is then re-saved).
 *                             Default: every sent row is marked as confirmed.
 *   onSynced(results)      → called after a fully successful run (e.g. cache.requestRefresh(true))
 *   onFatal(res)           → server REFUSED (login expired / no permission). Changes are KEPT as pending;
 *                             roll back your own last change here if you want it undone.
 *   onChange(state)        → { pending, syncing, error, online } for custom UI
 *   toast(msg, type)       → default console
 *   errText(msg)           → default AP2Api.errText or the raw message
 *   isFatal(err)           → default: /unauthori[sz]ed|forbidden|not logged in|session/i
 *   retryMs (10000) · lockMs (30000, cross-tab lock lease)
 *
 * API RETURNED
 *   start() · sync({silent}) · pendingCount() · isPending() · snapshotNow() · forgetSnapshot()
 *   resume() · refreshUI()
 *
 * EXTRAS
 *   AP2Sync.localStore(key, {toast})  → { load(default), save(value) }   (reports write failures)
 *   AP2Sync.savedMsg('Entry saved')   → adds "— saved on this device, will sync when online" if offline
 */
(function (root) {
  'use strict';

  const clone = v => JSON.parse(JSON.stringify(v));
  const same  = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const online = () => (typeof navigator === 'undefined' || navigator.onLine !== false);
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };

  function create(cfg) {
    if (!cfg || !cfg.key || typeof cfg.getCurrent !== 'function')
      throw new Error('AP2Sync.create: "key" and "getCurrent" are required');

    const A = Object.assign({ add: 'add', update: 'update', remove: 'delete' }, cfg.actions);
    const K = { snap: cfg.key + '_sync_snapshot', fail: cfg.key + '_sync_failed', lock: cfg.key + '_sync_lock' };
    const retryMs = cfg.retryMs || 10000, lockMs = cfg.lockMs || 30000;
    const tabId = Math.random().toString(36).slice(2);

    const toast   = (m, t) => { try { (cfg.toast || ((x) => console.log('[AP2Sync]', x)))(m, t); } catch (e) {} };
    const post    = (a, p) => (cfg.post || (root.AP2Api && root.AP2Api.post) || (() => Promise.reject(new Error('AP2Api not loaded'))))(a, p);
    const errText = m => cfg.errText ? cfg.errText(m) : (root.AP2Api && root.AP2Api.errText ? root.AP2Api.errText(m) : String(m || 'Sync failed'));
    const isFatal = cfg.isFatal || (e => /unauthori[sz]ed|forbidden|not logged in|session/i.test(String(e && e.message || e)));
    const rowOut  = cfg.rowOut || (r => r);
    const idOut   = cfg.idOut  || (i => i);
    const rowsPayload = cfg.rowsPayload || (rows => ({ rows }));
    const idsPayload  = cfg.idsPayload  || (ids => ({ ids }));

    /* ── snapshot = what the backend last confirmed ── */
    const loadSnap = () => { try { return JSON.parse(lsGet(K.snap) || 'null'); } catch (e) { return null; } };
    const saveSnap = m => {
      if (!lsSet(K.snap, JSON.stringify(m))) toast('Device storage is full — sync state could not be saved', 'error');
    };

    function diff(cur, snap) {
      const adds = [], upds = [], dels = [];
      Object.keys(cur).forEach(id => {
        if (!(id in snap)) adds.push([id, cur[id]]);
        else if (!same(snap[id], cur[id])) upds.push([id, cur[id]]);
      });
      Object.keys(snap).forEach(id => { if (!(id in cur)) dels.push(id); });
      return { adds, upds, dels };
    }
    function pendingCount() {
      const snap = loadSnap(); if (!snap) return 0;
      const d = diff(cfg.getCurrent(), snap);
      return d.adds.length + d.upds.length + d.dels.length;
    }
    const isPending = () => pendingCount() > 0;

    /* ── cross-tab lease so two open tabs never send the same change twice ── */
    function lockMine() { return JSON.stringify({ t: Date.now(), id: tabId }); }
    function acquire() {
      try {
        const cur = JSON.parse(lsGet(K.lock) || 'null');
        if (cur && cur.id !== tabId && Date.now() - cur.t < lockMs) return false;
        lsSet(K.lock, lockMine());
        const back = JSON.parse(lsGet(K.lock) || 'null');
        return !back || back.id === tabId;
      } catch (e) { return true; }
    }
    const renew   = () => lsSet(K.lock, lockMine());
    const release = () => { try { const c = JSON.parse(lsGet(K.lock) || 'null'); if (!c || c.id === tabId) lsDel(K.lock); } catch (e) {} };

    /* ── one pass: send the difference ── */
    async function runOnce() {
      const cur = cfg.getCurrent();
      const snap = loadSnap();
      if (!snap) { saveSnap(cur); return { ok: true }; }                 // first ever run: current state is the baseline
      const d = diff(cur, snap);
      if (!d.adds.length && !d.upds.length && !d.dels.length) return { ok: true };

      const next = Object.assign({}, snap);
      const out = { ok: true, added: 0, updated: 0, deleted: 0 };
      try {
        if (d.adds.length) {
          renew();
          const resp = await post(A.add, rowsPayload(d.adds.map(x => rowOut(x[1]))));
          let changed = false;
          if (cfg.onAdded) changed = !!cfg.onAdded(resp, d.adds, next);
          else d.adds.forEach(([id, row]) => { next[id] = clone(row); });
          out.added = d.adds.length; out.dataChanged = changed;
          saveSnap(next);                                                  // keep progress even if a later step fails
        }
        if (d.upds.length) {
          renew();
          await post(A.update, rowsPayload(d.upds.map(x => rowOut(x[1]))));
          d.upds.forEach(([id, row]) => { next[id] = clone(row); });
          out.updated = d.upds.length; saveSnap(next);
        }
        if (d.dels.length) {
          renew();
          await post(A.remove, idsPayload(d.dels.map(idOut)));
          d.dels.forEach(id => { delete next[id]; });
          out.deleted = d.dels.length; saveSnap(next);
        }
        saveSnap(next);
        return out;
      } catch (e) {
        saveSnap(next);
        return { ok: false, error: errText(e && e.message), fatal: !!isFatal(e), raw: e };
      }
    }

    /* ── coalesce calls: while one run is going, remember to run once more ── */
    let running = null, again = false, authBlocked = false;
    function run() {
      if (running) { again = true; return running; }
      running = (async () => {
        await null;                                                        // always yield once, so `running` is assigned before the finally below clears it
        let res = { ok: true }, got = false;
        try {
          got = acquire();
          if (!got) return { ok: false, busy: true };                      // another tab is syncing
          do { again = false; res = await runOnce(); } while (again && res.ok);
        } finally { if (got) release(); running = null; }
        return res;
      })();
      return running;
    }

    /* ── indicator ── */
    function refreshUI(err) {
      const n = pendingCount(), on = online();
      const el = cfg.indicator && document.getElementById(cfg.indicator);
      if (el) {
        el.style.display = n ? '' : 'none';
        const c = el.querySelector('.sync-n'); if (c) c.textContent = n;
        el.title = n ? n + ' change' + (n > 1 ? 's' : '') + ' saved on this device, waiting to sync'
                       + (!on ? ' (offline)' : err ? ' (' + err + ')' : '') + ' — click to retry now' : '';
      }
      if (cfg.onChange) { try { cfg.onChange({ pending: n, syncing: !!running, error: err || null, online: on }); } catch (e) {} }
    }
    function busy(b) {
      const el = cfg.indicator && document.getElementById(cfg.indicator);
      if (el) el.classList.toggle('busy', !!b);
      if (cfg.onChange) { try { cfg.onChange({ pending: pendingCount(), syncing: !!b, error: null, online: online() }); } catch (e) {} }
    }

    /* ── public: call after every local save ── */
    async function sync(opts) {
      opts = opts || {};
      if (!opts.auto) authBlocked = false;                                 // a person asked → try again even after a refusal
      if (!online() && !opts.force) {                                      // known offline: don't even try, just show pending
        lsSet(K.fail, '1'); refreshUI(); return { ok: false, offline: true };
      }
      busy(true);
      const res = await run();
      busy(false);
      if (res.busy) { refreshUI(); return res; }
      if (!res.ok) {
        lsSet(K.fail, '1');
        refreshUI(res.error);
        if (res.fatal) {
          authBlocked = true;                                              // stop hammering a server that said no
          if (!opts.silent) toast(res.error, 'error');
          if (cfg.onFatal) { try { cfg.onFatal(res); } catch (e) {} refreshUI(res.error); }
        }
      } else {
        refreshUI();
        if (res.dataChanged && cfg.onDataChanged) { try { cfg.onDataChanged(); } catch (e) {} }
        const had = lsGet(K.fail) === '1'; if (had) lsDel(K.fail);
        if (had && !pendingCount()) toast('Saved — all pending changes are now synced', 'success');
        if (cfg.onSynced && (res.added || res.updated || res.deleted)) { try { cfg.onSynced(res); } catch (e) {} }
      }
      return res;
    }

    /* ── lifecycle ── */
    let started = false;
    function start() {
      if (started) return; started = true;
      if (!loadSnap()) saveSnap(cfg.getCurrent());
      if (isPending()) lsSet(K.fail, '1');                                 // left over from last session → confirm when it goes through
      const auto = () => { if (!authBlocked && isPending()) sync({ silent: true, auto: true }); };
      window.addEventListener('online', () => { authBlocked = false; auto(); });
      window.addEventListener('offline', () => refreshUI());
      document.addEventListener('visibilitychange', () => { if (!document.hidden) auto(); });
      setInterval(() => { if (online()) auto(); }, retryMs);
      const el = cfg.indicator && document.getElementById(cfg.indicator);
      if (el) el.addEventListener('click', () => sync({ force: true }));
      refreshUI();
      auto();
    }

    return {
      start, sync, pendingCount, isPending, refreshUI,
      resume: () => { authBlocked = false; },                              // call after the user logs in again
      snapshotNow: () => { saveSnap(cfg.getCurrent()); refreshUI(); },     // "backend = what I have now" (e.g. right after loading from cache)
      forgetSnapshot: () => { lsDel(K.snap); lsDel(K.fail); refreshUI(); }
    };
  }

  /* ── localStorage wrapper that tells the user when a write fails (instead of a silent console warning) ── */
  function localStore(key, opts) {
    opts = opts || {}; let lastWarn = 0;
    return {
      load(def) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch (e) { console.warn('[AP2Sync] read failed', key, e.message); return def; } },
      save(val) {
        try { localStorage.setItem(key, JSON.stringify(val)); return true; }
        catch (e) {
          console.warn('[AP2Sync] write failed', key, e.message);
          if (Date.now() - lastWarn > 30000 && opts.toast) { lastWarn = Date.now(); opts.toast('Could not save on this device (storage full or blocked) — data may be lost on reload', 'error'); }
          return false;
        }
      }
    };
  }

  const savedMsg = msg => online() ? msg : msg + ' — saved on this device, will sync when online';

  root.AP2Sync = { create, localStore, savedMsg, version: 1 };
})(typeof window !== 'undefined' ? window : globalThis);
