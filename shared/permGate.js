/* ═══════════════════════════════════════════════════════════════
 *  shared/permGate.js   —   ONE permission gate for every module page
 *
 *  Decides from the logged-in user's session permissions
 *  (Auth.getPermissions() → { ap2_bills:{access:{view,add,editDelete}}, … })
 *  whether a button / action is allowed — in the FRONT END, before the
 *  click does anything, before the network, before the backend.
 *
 *  Three layers (all driven by the same rules):
 *    1. BUTTONS   denied controls are disabled + tooltip (re-applied after every render)
 *    2. CLICKS    a capture-phase click guard stops denied clicks before any page handler runs
 *    3. API       AP2Api.post() refuses a denied action before fetch() is ever called
 *  plus a fixed label (bottom-left, same place on every page):
 *    "🔒 Permission not granted — Bills: add · Ledger: add, edit / delete"
 *
 *  Load order (after accessGuard.js, BEFORE the page's own script):
 *    <script src=".../shared/api.js"></script>
 *    <script src=".../shared/auth.js"></script>
 *    <script src=".../shared/accessGuard.js"></script>
 *    <script src=".../shared/permGate.js?v=1"></script>
 *
 *  Then, once, at the end of the page (after its own script):
 *    PermGate.init({
 *      dataset : 'ap2_ledger',                       // default dataset for rules below
 *      controls: [
 *        { sel:'#sv,#sv2',            need:'add',        fn:['save','saveC'] },
 *        { sel:'[onclick^="rev("]',   need:'add&editDelete', fn:'rev' }
 *      ]
 *    });
 *
 *  need  = 'view' | 'add' | 'editDelete'            (uses the default dataset)
 *          'ap2_bills:add'                           (explicit dataset)
 *          'add|editDelete'                          (ANY of)
 *          'ap2_bills:add&ap2_ledger:add'            (ALL of)
 *          () => '…'                                 (function evaluated at use time)
 *  clickNeed (optional)  a more precise need checked only at click time
 *  fn        (optional)  global function name(s) to also guard when called directly
 *
 *  Fails closed: no session / no permissions → everything is denied.
 * ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  if (global.PermGate) return;
  var D = global.document;

  /* friendly names — the session's own permission label wins when present */
  var DS_LABEL = {
    ap2_bills: 'Bills', ap2_ledger: 'Ledger', ap2_orders: 'Orders',
    ap2_minStock: 'Stock Threshold', ap2_rateThreshold: 'Rate Threshold',
    ap2_specsData: 'Specs Settings', ap2_loginData: 'User Admin'
  };
  var ACT_LABEL = { view: 'view', add: 'add', editDelete: 'edit / delete' };

  /* ── backend action → permission needed (checked inside AP2Api.post, before fetch) ──
        add…  = 'add'      update… / delete… / set… / reverse… = 'editDelete'
        reads (…List, get…) are not listed → never blocked here                           */
  var ACTION_RULES = {
    addBill: 'ap2_bills:add',               updateBill: 'ap2_bills:editDelete',   deleteBill: 'ap2_bills:editDelete',
    addPayment: 'ap2_bills:add',            updatePayment: 'ap2_bills:editDelete', deletePayment: 'ap2_bills:editDelete',
    addCharges: 'ap2_ledger:add',           addReceipt: 'ap2_ledger:add',          addAllocations: 'ap2_ledger:add',
    reverseBill: 'ap2_ledger:editDelete',
    addOrder: 'ap2_orders:add',             updateOrder: 'ap2_orders:editDelete',  deleteOrder: 'ap2_orders:editDelete',
    addRateThreshold: 'ap2_rateThreshold:add', updateRateThreshold: 'ap2_rateThreshold:editDelete',
    setRateThresholdStatus: 'ap2_rateThreshold:editDelete', deleteRateThreshold: 'ap2_rateThreshold:editDelete',
    minStockSave: 'ap2_minStock:add|ap2_minStock:editDelete', minStockDelete: 'ap2_minStock:editDelete',
    addSpecsSetting: 'ap2_specsData:add',   updateSpecsSetting: 'ap2_specsData:editDelete', deleteSpecsSetting: 'ap2_specsData:editDelete'
  };

  /* ── permission lookup ── */
  function perms() {
    try { return (global.Auth && typeof global.Auth.getPermissions === 'function' && global.Auth.getPermissions()) || null; }
    catch (e) { return null; }
  }
  function can(ds, act) {
    try {
      if (global.AccessGuard && typeof global.AccessGuard.can === 'function') return global.AccessGuard.can(ds, act) === true;
      if (global.Auth && typeof global.Auth.canDo === 'function') return global.Auth.canDo(ds, act) === true;
    } catch (e) {}
    return false;
  }
  function dsLabel(ds) {
    var p = perms(); var o = p && p[ds];
    return (o && typeof o === 'object' && o.label) || DS_LABEL[ds] || ds;
  }

  /* ── need-expression:  'add' · 'ds:add' · 'a|b' (any) · 'a&b' (all) ── */
  function parse(expr, def) {
    return String(expr).split('|').map(function (grp) {
      return grp.split('&').map(function (t) {
        t = t.trim(); var i = t.indexOf(':');
        return i < 0 ? { ds: def, act: t } : { ds: t.slice(0, i).trim(), act: t.slice(i + 1).trim() };
      });
    });
  }
  function resolve(expr) { return typeof expr === 'function' ? expr() : expr; }
  function allowed(expr, def) {
    expr = resolve(expr); if (!expr) return true;
    return parse(expr, def).some(function (g) { return g.every(function (t) { return can(t.ds, t.act); }); });
  }
  /* "Bills: add · Ledger: edit / delete" — what is missing in this expression */
  function missingText(expr, def) {
    expr = resolve(expr); if (!expr) return '';
    var by = {}, order = [];
    parse(expr, def).forEach(function (g) { g.forEach(function (t) {
      if (can(t.ds, t.act)) return;
      if (!by[t.ds]) { by[t.ds] = []; order.push(t.ds); }
      var a = ACT_LABEL[t.act] || t.act; if (by[t.ds].indexOf(a) < 0) by[t.ds].push(a);
    }); });
    return order.map(function (ds) { return dsLabel(ds) + ': ' + by[ds].join(', '); }).join(' · ');
  }
  function denyMsg(expr, def) {
    var m = missingText(expr, def);
    return 'Permission not granted' + (m ? ' — ' + m : '');
  }

  /* ── feedback ── */
  var _lastToast = 0;
  function toast(msg) {
    var now = Date.now(); if (now - _lastToast < 600) return; _lastToast = now;
    try {
      if (typeof global.showToast === 'function') return global.showToast('⛔ ' + msg, 'error');
      if (typeof global.toast === 'function') return global.toast('⛔ ' + msg, 'error');
    } catch (e) {}
    console.warn('[PermGate]', msg);
  }
  function deny(expr, def) { toast(denyMsg(expr, def)); }

  /* ── layer 3: AP2Api.post refuses denied actions before fetch ── */
  function guardApi() {
    var api = global.AP2Api;
    if (!api || typeof api.post !== 'function' || api.post.__pg) return;
    var orig = api.post;
    var w = function (action) {
      var rule = ACTION_RULES[action];
      if (rule && !allowed(rule)) {
        // "Forbidden" → AP2Api.isFatal() treats it as a refusal (never retried); no network call is made
        return Promise.reject(new Error('Forbidden — ' + denyMsg(rule)));
      }
      return orig.apply(this, arguments);
    };
    w.__pg = true; api.post = w;
  }
  guardApi();   // installed immediately, so pages that do `const post = AP2Api.post` get the guarded one

  /* ── page configs ── */
  var cfgs = [];

  function nodes(sel) { try { return D.querySelectorAll(sel); } catch (e) { return []; } }

  function setState(el, ok, expr, def) {
    var flagged = el.getAttribute('data-pg-off') === '1';
    var isForm = 'disabled' in el;
    if (!ok) {
      if (!flagged) { el.setAttribute('data-pg-off', '1'); el.setAttribute('data-pg-t', el.getAttribute('title') || ''); }
      if (isForm) { if (!el.disabled) el.disabled = true; }
      else el.setAttribute('aria-disabled', 'true');
      el.classList.add('pg-off');
      var tip = denyMsg(expr, def); if (el.getAttribute('title') !== tip) el.setAttribute('title', tip);
    } else if (flagged) {            // only undo what WE disabled — a page may disable buttons itself (e.g. while saving)
      el.removeAttribute('data-pg-off');
      if (isForm) el.disabled = false; else el.removeAttribute('aria-disabled');
      el.classList.remove('pg-off');
      var t = el.getAttribute('data-pg-t'); el.removeAttribute('data-pg-t');
      if (t) el.setAttribute('title', t); else el.removeAttribute('title');
    }
  }

  /* ── the label (same place on every page) ── */
  var chip = null;
  function ensureChip() {
    if (chip && D.body && D.body.contains(chip)) return chip;
    if (!D.body) return null;
    chip = D.createElement('div'); chip.id = 'pg-chip'; chip.setAttribute('role', 'status'); chip.style.display = 'none';
    D.body.appendChild(chip); return chip;
  }
  function renderChip() {
    var el = ensureChip(); if (!el) return;
    var by = {}, order = [], any = false;
    cfgs.forEach(function (cfg) { cfg.controls.forEach(function (c) {
      if (typeof c.need === 'function' || !c.need) return;
      if (allowed(c.need, cfg.dataset)) return;
      any = true;
      var txt = missingText(c.need, cfg.dataset);
      txt.split(' · ').forEach(function (part) { if (part && order.indexOf(part) < 0) order.push(part); });
    }); });
    var text = '';
    if (any) {
      var p = perms();
      text = p ? '🔒 Permission not granted — ' + mergeParts(order) : '🔒 Permissions not loaded — actions are disabled';
    }
    if (el.textContent !== text) el.textContent = text;
    var disp = text ? 'block' : 'none'; if (el.style.display !== disp) el.style.display = disp;
    if (text) el.setAttribute('title', 'Your account has view-only or limited access here. Ask an admin to change your permissions in User Admin.');
  }
  /* ["Bills: add","Bills: edit / delete","Ledger: add"] → "Bills: add, edit / delete · Ledger: add" */
  function mergeParts(parts) {
    var by = {}, ord = [];
    parts.forEach(function (s) {
      var i = s.indexOf(': '); var k = s.slice(0, i), v = s.slice(i + 2);
      if (!by[k]) { by[k] = []; ord.push(k); }
      v.split(', ').forEach(function (a) { if (by[k].indexOf(a) < 0) by[k].push(a); });
    });
    return ord.map(function (k) { return k + ': ' + by[k].join(', '); }).join(' · ');
  }

  /* ── layer 1: apply to the DOM ── */
  function apply() {
    cfgs.forEach(function (cfg) {
      cfg.controls.forEach(function (c) {
        var ok = allowed(c.need, cfg.dataset);
        nodes(c.sel).forEach(function (el) { setState(el, ok, c.need, cfg.dataset); });
      });
    });
    renderChip();
  }

  /* ── layer 2: capture-phase click guard (runs before any inline / delegated handler) ── */
  function onClick(e) {
    var t = e.target; if (!t || !t.closest) return;
    for (var i = 0; i < cfgs.length; i++) {
      var cfg = cfgs[i];
      for (var j = 0; j < cfg.controls.length; j++) {
        var c = cfg.controls[j], hit = null;
        try { hit = t.closest(c.sel); } catch (err) {}
        if (!hit) continue;
        var need = c.clickNeed ? function () { return c.clickNeed(hit); } : c.need;
        if (!allowed(need, cfg.dataset)) {
          e.preventDefault(); e.stopImmediatePropagation();
          deny(need, cfg.dataset);
          return;
        }
      }
    }
  }

  /* also guard functions that are called by name (keyboard shortcuts, other code) */
  function wrapFn(name, getNeed, def) {
    var orig = global[name];
    if (typeof orig !== 'function' || orig.__pg) return;
    var w = function () {
      var need = getNeed.apply(this, arguments);
      if (!allowed(need, def)) { deny(need, def); return; }
      return orig.apply(this, arguments);
    };
    w.__pg = true; global[name] = w;
  }

  var _wired = false, _raf = 0;
  function schedule() { if (_raf) return; _raf = global.requestAnimationFrame(function () { _raf = 0; try { apply(); } catch (e) {} }); }
  function wire() {
    if (_wired) return; _wired = true;
    D.addEventListener('click', onClick, true);
    try { new MutationObserver(schedule).observe(D.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] }); } catch (e) {}
    global.setInterval(schedule, 1500);             // permissions may arrive after the page paints
    global.addEventListener('storage', schedule);
    global.addEventListener('message', schedule);   // portal session hand-over
  }

  function injectCss() {
    if (D.getElementById('pg-css')) return;
    var st = D.createElement('style'); st.id = 'pg-css';
    st.textContent =
      '.pg-off{opacity:.4!important;cursor:not-allowed!important;filter:grayscale(.4)}' +
      '#pg-chip{position:fixed;left:14px;bottom:14px;z-index:90;max-width:min(520px,calc(100vw - 28px));' +
      'padding:7px 12px;border-radius:8px;font:600 12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;' +
      'background:var(--red-dim,rgba(248,81,73,.14));color:var(--red,#f85149);border:1px solid var(--red,#f85149);' +
      'box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:auto;cursor:default}';
    (D.head || D.documentElement).appendChild(st);
  }

  /* ── public ── */
  function init(cfg) {
    cfg = cfg || {};
    var c = { dataset: cfg.dataset || '', controls: (cfg.controls || []).slice() };
    cfgs.push(c);
    c.controls.forEach(function (ctl) {
      var fns = ctl.fn ? [].concat(ctl.fn) : [];
      fns.forEach(function (name) { wrapFn(name, function () { return ctl.clickNeed ? ctl.clickNeed(null) : ctl.need; }, c.dataset); });
    });
    guardApi();
    injectCss();
    wire();
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', schedule); else apply();
    return api;
  }

  var api = {
    init: init,
    refresh: apply,
    can: function (expr, def) { return allowed(expr, def); },
    require: function (expr, def) { var ok = allowed(expr, def); if (!ok) deny(expr, def); return ok; },
    registerActions: function (map) { Object.keys(map || {}).forEach(function (k) { ACTION_RULES[k] = map[k]; }); },
    actionRules: ACTION_RULES
  };
  global.PermGate = api;
})(window);
