/* ═══════════════════════════════════════════════════════════════
 *  shared/syncQueue.js   —   offline "hold & sync" + the cache / sync buttons, for every module
 *  (the behaviour Master.html has, as one shared file)
 *
 *  What it does
 *    • Permitted user, no network  →  the change is HELD on this device (localStorage),
 *      the page gets an immediate success answer, and the buttons show it:
 *         cache-ind  (database icon)    green = ok · amber = offline / changes waiting · red = log in again
 *         sync-ind   (cloud-upload)     red ping + number = changes held, click = retry now
 *    • Network is back  →  held changes are sent in the SAME order (AP2Api.startRetry: 'online' event + every 10 s)
 *      and "Saved — all pending changes are now synced" is shown.
 *    • Server REFUSES a held change (no permission) or rejects its data  →  dropped with a message
 *      (retrying can never fix it).  Session expired → kept, button turns red, sync resumes after login.
 *    • No permission  →  nothing is held (shared/permGate.js already stopped it before this runs).
 *    • Actions listed in  online:[…]  need the network (they depend on server numbers / live data):
 *      offline they are refused at once with "Network error" instead of failing half-way.
 *    • Creates #cache-ind / #sync-ind in the page header (.bar) when the page has none.
 *
 *  Load order (BEFORE the page's own script, after permGate.js):
 *    api.js → auth.js → accessGuard.js → permGate.js → syncQueue.js
 *
 *  Once, at the end of the page:
 *    AP2Sync.init({
 *      key     : 'receipts',                         // storage name — one per page
 *      queue   : ['addReceipt','addCharges'],        // actions that may be HELD offline (must carry their own client id)
 *      online  : ['addAllocations'],                 // actions that need the network
 *      extraPending: () => n,                        // optional: page's own queue size (added to the badge)
 *      extraFlush  : () => {…},                      // optional: retry the page's own queue
 *      state   : () => ({state:'ok'|'warn'|'err', title}),   // optional: for pages WITHOUT AP2Cache
 *      refresh : () => {…},                          // optional: what a click on cache-ind should reload
 *      onSynced: () => {…},                          // optional: reload after held changes were sent
 *      toast   : showToast                           // optional (defaults to window.showToast)
 *    });
 *
 *  AP2Sync.count() · AP2Sync.flush() · AP2Sync.offline() · AP2Sync.paint()
 * ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  if (global.AP2Sync) return;
  var D = global.document;

  var cfg = { key: '', queue: {}, online: {}, extraPending: null, extraFlush: null, state: null, refresh: null, onSynced: null, onQueued: null, toast: null };
  var inner = null;                       // the AP2Api.post that was there when we loaded (already permission-guarded)
  var Q = [], netDown = false, authBlock = false, flushing = false, started = false;

  /* ── helpers ── */
  var msgOf = function (e) { return String((e && e.message) || e || ''); };
  var isNet = function (m) {
    m = msgOf(m);
    try { if (global.AP2Api && AP2Api.isNetwork && AP2Api.isNetwork(m)) return true; } catch (e) {}
    return /failed to fetch|networkerror|network error|load failed|timeout|offline/i.test(m);
  };
  var offline = function () { return (global.navigator && navigator.onLine === false) || netDown; };
  var storeKey = function () { return 'ap2_syncq_v1:' + (cfg.key || 'page'); };
  function load() { try { Q = JSON.parse(localStorage.getItem(storeKey()) || '[]'); if (!Array.isArray(Q)) Q = []; } catch (e) { Q = []; } }
  function persist() { try { localStorage.setItem(storeKey(), JSON.stringify(Q)); } catch (e) {} }
  function toast(m, t) {
    try { if (cfg.toast) return cfg.toast(m, t); if (typeof global.showToast === 'function') return global.showToast(m, t); } catch (e) {}
    console.log('[AP2Sync]', m);
  }
  var pageCount = function () { try { return cfg.extraPending ? (+cfg.extraPending() || 0) : 0; } catch (e) { return 0; } };
  var total = function () { return Q.length + pageCount(); };
  /* permission denied → never hold it (the permGate layer rejects it before any network) */
  function denied(action) {
    try { var P = global.PermGate, r = P && P.actionRules && P.actionRules[action]; return !!(r && !P.can(r)); } catch (e) { return false; }
  }

  /* ── the answer a held write gives back to the page (so its own "saved" flow keeps working) ── */
  function stubFor(payload) {
    var res = { success: true, queued: true };
    Object.keys(payload || {}).forEach(function (k) {
      var v = payload[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) res[k] = Object.assign({}, v, { no: v.no || 'pending' });
    });
    return res;
  }
  function enqueue(action, payload) {
    var op = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), action: action, payload: payload, ts: Date.now() };
    Q.push(op); persist(); paint();
    try { if (cfg.onQueued) cfg.onQueued(op); } catch (e) {}
    /* shown a moment later so the page's own toast does not cover it */
    setTimeout(function () {
      toast(offline() ? 'No network — saved on this device, will sync when it is back' : 'Saved on this device — syncing…', 'info');
    }, 450);
    if (!offline()) setTimeout(function () { flush(false); }, 0);
    return stubFor(payload);
  }

  /* ── AP2Api.post wrapper — installed at load so `const post = AP2Api.post` in a page gets it ── */
  function route(self, args, action, payload) {
    var held = !!cfg.queue[action], only = !!cfg.online[action];
    if (!held && !only) return inner.apply(self, args);
    if (denied(action)) return inner.apply(self, args);                 // rejected "Forbidden" by the permission layer
    if (only) {
      if (offline()) return Promise.reject(new Error('Network error — this action needs a connection'));
      return inner.apply(self, args).catch(function (e) { if (isNet(e)) { netDown = true; paint(); } throw e; });
    }
    /* held action */
    if (Q.length || offline()) return Promise.resolve(enqueue(action, payload));   // keep the order: never jump the queue
    return inner.apply(self, args).then(
      function (r) { if (netDown) { netDown = false; paint(); } return r; },
      function (e) { if (isNet(e)) { netDown = true; return enqueue(action, payload); } throw e; }
    );
  }
  function install() {
    var api = global.AP2Api;
    if (!api || typeof api.post !== 'function' || api.post.__sq) return;
    inner = api.post;
    var w = function (action, payload) { return route(this, arguments, action, payload); };
    w.__sq = true; api.post = w;
  }
  install();

  /* ── send held changes, in order ── */
  async function flush(manual) {
    if (flushing || !inner) return;
    if (!Q.length) { paint(); return; }
    flushing = true; paint();
    var done = 0;
    try {
      while (Q.length) {
        if (global.navigator && navigator.onLine === false) { netDown = true; break; }
        var op = Q[0];
        try {
          await inner(op.action, op.payload);
          Q.shift(); persist(); done++; netDown = false; authBlock = false;
        } catch (e) {
          var m = msgOf(e);
          if (!isNet(m)) netDown = false;                                                   // the server answered → we are online
          if (isNet(m)) { netDown = true; break; }                                          // wait for the network
          if (/forbidden|permission not granted/i.test(m)) {                                // refused for good
            Q.shift(); persist();
            toast('Not synced — you do not have permission for ' + op.action, 'error'); continue;
          }
          if (/unauthori[sz]ed|not logged in|session/i.test(m)) { authBlock = true; break; } // keep it, log in again
          Q.shift(); persist();                                                             // server rejected the data itself
          toast('Not synced (' + op.action + '): ' + (global.AP2Api && AP2Api.errText ? AP2Api.errText(m) : m), 'error');
        }
      }
    } finally { flushing = false; }
    if (done && !Q.length) {
      toast('Saved — all pending changes are now synced', 'success');
      try { if (cfg.onSynced) cfg.onSynced(); } catch (e) {}
    } else if (manual && Q.length && offline()) toast('Still offline — changes are safe on this device', 'info');
    paint();
  }

  /* ── buttons ── */
  var $ = function (id) { return D.getElementById(id); };
  function ensureButtons() {
    if ($('cache-ind') && $('sync-ind')) return;
    var host = D.querySelector('.bar') || D.querySelector('header') || D.body; if (!host) return;
    if (!$('cache-ind')) {
      var b = D.createElement('button'); b.className = 'ib cache-ind warn'; b.id = 'cache-ind'; b.type = 'button'; b.title = 'Cache: waiting…';
      b.innerHTML = '<i class="ti ti-database"></i>'; host.appendChild(b);
    }
    if (!$('sync-ind')) {
      var s = D.createElement('button'); s.className = 'ib sync-ind'; s.id = 'sync-ind'; s.type = 'button'; s.style.display = 'none';
      s.innerHTML = '<i class="ti ti-cloud-upload"></i><span class="ping"></span><b class="sync-n">0</b>'; host.appendChild(s);
    }
  }
  function paint() {
    var n = total(), off = offline(), c = $('cache-ind'), s = $('sync-ind');
    if (s) {
      var disp = n ? '' : 'none'; if (s.style.display !== disp) s.style.display = disp;
      var num = s.querySelector('.sync-n'); if (num && num.textContent !== String(n)) num.textContent = n;
      var t = n ? n + ' change' + (n > 1 ? 's' : '') + ' saved on this device, waiting to sync' + (off ? ' (offline)' : '') + ' — click to retry now' : '';
      if (s.title !== t) s.title = t;
      if (s.classList.contains('busy') !== flushing) s.classList.toggle('busy', flushing);
    }
    if (!c) return;
    var want = null;
    if (authBlock)       want = { st: 'err',  t: 'Session expired — log in again to sync ' + n + ' change' + (n > 1 ? 's' : '') };
    else if (off)        want = { st: 'warn', t: 'Offline — showing saved data' + (n ? ' · ' + n + ' change' + (n > 1 ? 's' : '') + ' held on this device, will sync when the network is back' : '') };
    else if (n)          want = { st: 'warn', t: n + ' change' + (n > 1 ? 's' : '') + ' waiting to sync — click to retry' };
    else if (cfg.state) { try { var r = cfg.state(); if (r) want = { st: r.state || 'ok', t: r.title || '' }; } catch (e) {} }
    if (!want) return;                                              // AP2Cache owns the button
    var cls = 'ib cache-ind ' + want.st + (flushing ? ' busy' : '');
    if (c.className !== cls) c.className = cls;
    if (c.title !== want.t) c.title = want.t;
  }

  function start() {
    if (started) return; started = true;
    ensureButtons();
    var c = $('cache-ind'), s = $('sync-ind');
    if (c) c.addEventListener('click', function () {
      try { if (cfg.refresh) cfg.refresh(); } catch (e) {}
      if (total()) { flush(true); try { if (cfg.extraFlush) cfg.extraFlush(); } catch (e) {} }
      paint();
    });
    if (s) s.addEventListener('click', function () { flush(true); try { if (cfg.extraFlush) cfg.extraFlush(); } catch (e) {} });
    /* other scripts (AP2Cache, the page) rewrite these buttons — put our state back straight away */
    try {
      var mo = new MutationObserver(function () { paint(); });
      if (c) mo.observe(c, { attributes: true, attributeFilter: ['class', 'title'] });
      if (s) mo.observe(s, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: ['style', 'title', 'class'] });
    } catch (e) {}
    global.addEventListener('online',  function () { netDown = false; paint(); flush(false); try { if (cfg.extraFlush && pageCount()) cfg.extraFlush(); } catch (e) {} });
    global.addEventListener('offline', function () { paint(); });
    try {
      if (global.AP2Api && AP2Api.startRetry)
        AP2Api.startRetry(function () { if (Q.length) flush(false); try { if (cfg.extraFlush && pageCount()) cfg.extraFlush(); } catch (e) {} paint(); }, total);
    } catch (e) {}
    global.setInterval(paint, 2000);                                // keeps pages without AP2Cache in step with their own state
    paint();
  }

  function init(o) {
    o = o || {};
    cfg.key = o.key || cfg.key || 'page';
    cfg.queue = {}; (o.queue || []).forEach(function (a) { cfg.queue[a] = 1; });
    cfg.online = {}; (o.online || []).forEach(function (a) { cfg.online[a] = 1; });
    ['extraPending', 'extraFlush', 'state', 'refresh', 'onSynced', 'onQueued', 'toast'].forEach(function (k) { if (typeof o[k] === 'function') cfg[k] = o[k]; });
    install(); load();
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', start); else start();
    return api;
  }

  var api = {
    init: init, flush: flush, paint: paint,
    count: total, offline: offline,
    held: function () { return Q.slice(); }
  };
  global.AP2Sync = api;
})(window);
