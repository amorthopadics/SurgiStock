/* ═══════════════════════════════════════════════════════════════
 *  shared/api.js   —   ONE place for the backend API (all modules)
 *
 *  Load before your module script:
 *    <script src="https://amorthopadics.github.io/SurgiStock/shared/api.js?v=1"></script>
 *
 *  window.AP2Api
 *    .ENDPOINT                      Apps Script web-app URL (change it HERE only)
 *    .session()                     { sessionId, token }  (portal storage → parent handshake)
 *    .onSession(fn)                 call fn when the portal hands over the session
 *    .post(action, payload)         POST  → parsed JSON (throws Error on failure)
 *    .get(type, params)             GET ?type=…  → parsed JSON (throws Error on failure)
 *    .errText(msg)                  friendly message for an error
 *    .isFatal(msg)                  true = server REFUSED it (retrying won't help)
 *    .isNetwork(msg)                true = offline / temporary (keep it, retry later)
 *    .startRetry(fn, hasPending)    run fn when the network comes back + every 10 s while
 *                                   hasPending() is true  (the "wait for network" engine)
 *    .syncBadge(id)                 helper for the red cloud-upload "waiting to sync" button
 * ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  if (global.AP2Api) return;

  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbzBkdKALI8tc53cgUaAlD5Mhlds1GUs7Sl3ZrlXY80nUXEfmxzhMb5ScQYaVeBuk4-C/exec';

  /* ── session: same lookup order every module used before ── */
  let SES = null;
  const sessListeners = [];
  global.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'ap-session-ready') {
      SES = { sessionId: m.sessionId, token: m.token, email: m.email };
      sessListeners.forEach(fn => { try { fn(SES); } catch (err) {} });
    }
  });
  try { global.parent.postMessage({ type: 'ap-session-request' }, '*'); } catch (e) {}

  function session() {
    let sid = '', tok = '';
    try {
      const raw = sessionStorage.getItem('ap_session') || localStorage.getItem('ap_session') || '';
      if (raw) { try { const o = JSON.parse(raw); sid = o.sessionId || o.id || ''; tok = o.token || ''; } catch (e) { sid = raw; } }
      sid = sid || sessionStorage.getItem('ap_sessionId') || localStorage.getItem('ap_sessionId') || '';
      tok = tok || sessionStorage.getItem('ap_token') || localStorage.getItem('ap_token') || '';
    } catch (e) {}
    if (!sid && !tok && SES) { sid = SES.sessionId || ''; tok = SES.token || ''; }
    return { sessionId: sid, token: tok };
  }
  function onSession(fn) { sessListeners.push(fn); if (SES) { try { fn(SES); } catch (e) {} } }

  /* ── errors ── */
  function errText(m) {
    m = String(m || '');
    if (/not logged in/i.test(m))                       return 'You must be logged in to save changes';
    if (/unauthori[sz]ed/i.test(m))                     return 'Session expired — please log in again';
    if (/forbidden/i.test(m))                           return 'You do not have permission for this action';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Network error — check your connection';
    return m || 'Unknown error';
  }
  const isFatal   = m => /unauthori[sz]ed|forbidden|not logged in/i.test(String(m || ''));
  const isNetwork = m => /failed to fetch|network|load failed|timeout/i.test(String(m || ''));

  /* ── calls ── */
  async function post(action, payload) {
    const s = session();
    if (!s.sessionId && !s.token) throw new Error('Not logged in');   // blocked before sending
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, s, payload))
    });
    const j = await res.json();
    if (!j || j.success === false) throw new Error((j && j.error) || (action + ' failed'));
    return j;
  }
  async function get(type, params) {
    const s = session();
    if (!s.sessionId && !s.token) throw new Error('Not logged in');
    const q = new URLSearchParams(Object.assign({ type }, s, params || {}));
    const res = await fetch(ENDPOINT + '?' + q.toString());
    const j = await res.json();
    if (!j || j.success === false) throw new Error((j && j.error) || 'Load failed');
    return j;
  }

  /* ── wait-for-network engine ──
     fn()          your sync function (must be safe to call repeatedly)
     hasPending()  true while something still has to be saved                */
  function startRetry(fn, hasPending, every) {
    const run = () => { try { if (navigator.onLine !== false && (!hasPending || hasPending())) fn(); } catch (e) {} };
    global.addEventListener('online', run);
    setInterval(run, every || 10000);
    run();
  }

  /* ── the red "waiting to sync" button:  <button id="sync-ind" class="ib sync-ind">…<b class="sync-n">0</b></button> ── */
  function syncBadge(id) {
    const el = () => document.getElementById(id || 'sync-ind');
    return {
      update(n, err) {
        const e = el(); if (!e) return;
        e.style.display = n ? '' : 'none';
        const c = e.querySelector('.sync-n'); if (c) c.textContent = n;
        e.title = n ? n + ' change' + (n > 1 ? 's' : '') + ' saved on this device, waiting to sync' + (err ? ' (' + err + ')' : '') + ' — click to retry now' : '';
      },
      busy(b) { const e = el(); if (e) e.classList.toggle('busy', !!b); },
      onClick(fn) { const e = el(); if (e) e.addEventListener('click', fn); }
    };
  }

  /* indicator + spinner styles, injected once at the TOP of <head> so a page's own CSS still wins */
  if (!document.getElementById('ap2-shared-css')) {
    const st = document.createElement('style'); st.id = 'ap2-shared-css';
    st.textContent =
      '@keyframes ap2spin{to{transform:rotate(360deg)}}@keyframes ap2ping{0%{transform:scale(1);opacity:.7}100%{transform:scale(2.6);opacity:0}}' +
      '.cache-ind{margin-left:auto}.cache-ind,.cache-ind:hover,.sync-ind,.sync-ind:hover{background:none;border:0;box-shadow:none}' +
      '.cache-ind.ok{color:var(--teal,#39d353)}.cache-ind.warn{color:var(--amber,#e3b341)}.cache-ind.err{color:var(--red,#f85149)}' +
      '.cache-ind.busy i,.sync-ind.busy>i{animation:ap2spin 1s linear infinite}' +
      '.sync-ind{position:relative;color:var(--red,#f85149)}' +
      '.sync-ind .ping{position:absolute;top:2px;right:2px;width:9px;height:9px;border-radius:50%;background:var(--red,#f85149)}' +
      '.sync-ind .ping::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--red,#f85149);animation:ap2ping 1.4s ease-out infinite}' +
      '.sync-ind .sync-n{position:absolute;bottom:-3px;right:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--red,#f85149);color:#fff;font-size:9px;line-height:14px;text-align:center}';
    (document.head || document.documentElement).insertBefore(st, (document.head || document.documentElement).firstChild);
  }

  global.AP2Api = { ENDPOINT, session, onSession, post, get, errText, isFatal, isNetwork, startRetry, syncBadge };
})(window);
