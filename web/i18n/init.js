// i18next bootstrap for the remakes. No fetch: resources come from en.js / pt.js.
// ?lang=xx forces a language (pt* -> pt, anything else known -> that code, else en). Fallback: en.
(function (G) {
  'use strict';
  function base(code) {
    const c = String(code || '').toLowerCase().replace('_', '-');
    if (!c) return null;
    if (c === 'pt' || c.startsWith('pt-')) return 'pt';
    if (c === 'en' || c.startsWith('en-')) return 'en';
    return c.split('-')[0];
  }
  function detect() {
    try {
      const q = new URLSearchParams(location.search);
      const forced = q.get('lang');
      if (forced) return base(forced) || 'en';
      const list = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || ['en'];
      for (const L of list) { const b = base(L); if (b === 'pt' || b === 'en') return b; }
    } catch (e) {}
    return 'en';
  }
  const resources = G.SSRI18N_RESOURCES || {};
  const lng = (typeof location !== 'undefined') ? detect() : 'en';
  const api = G.i18next || (typeof i18next !== 'undefined' ? i18next : null);
  if (!api) { console.warn('[i18n] i18next missing'); G.t = (k) => k; G.SSRI18N = { t: G.t, language: 'en', ready: false }; return; }
  api.init({
    lng,
    fallbackLng: 'en',
    resources,
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false
  });
  function t(key, opts) { return api.t(key, opts); }
  G.t = t;
  G.SSRI18N = {
    t,
    language: api.language || lng,
    ready: true,
    changeLanguage: function (l) { return api.changeLanguage(base(l) || l); },
    // safe helper for node/tests when i18n is not loaded: tOr(key, fallback, opts)
    tOr: function (key, fallback, opts) {
      try { if (api.isInitialized) return api.t(key, opts); } catch (e) {}
      return fallback;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
