/* ══════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA — SHARED TENANT REGISTRY (single source of truth)
   ----------------------------------------------------------------------
   Loaded by every portal page (index.html, marketplace.html, projects.html)
   BEFORE their inline scripts, so all pages resolve the same tenant, tier,
   required tools, and export branding from ONE place.

   Add a new tenant here ONCE and every page picks it up. Do NOT re-declare
   WORKSPACES inside a page; read window.OMEGA_WORKSPACES instead.

   Usage in a page:
     var WORKSPACES = window.OMEGA_WORKSPACES;
     var ws = OMEGA_resolveWorkspace(user.email);   // helper below
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  var WORKSPACES = {

    // ─────────────── DEVELOPER (ENTERPRISE CLIENT) TENANTS ───────────────
    'nextnrg.com': {
      type: 'developer',
      orgId: 'nextnrg.com',
      clientName: 'NextNRG',
      accountTier: 'Enterprise',
      tierLevel: 3,
      allowedDomain: 'nextnrg.com',
      requiredTools: ['editor', 'sandbox', 'investment', 'sales'],
      logo: '/nextnrg-logo.png',
      exportBrand: {
        logo: '/nextnrg-logo.png',
        name: 'NextNRG',
        poweredBy: 'Powered by ClearSky-OMEGA',
        platformCopyright: '© 2025 ClearSky Energy Solutions LLC · ClearSky-OMEGA platform'
      }
    },

    'spatco.com': {
      type: 'developer',
      orgId: 'spatco.com',
      clientName: 'SPATCO Energy Solutions',
      accountTier: 'Enterprise',
      tierLevel: 3,
      allowedDomain: 'spatco.com',
      requiredTools: ['editor', 'spatco_ev'],
      logo: '/spatco-logo.jpg',
      exportBrand: {
        logo: '/spatco-logo.jpg',
        name: 'SPATCO Energy Solutions',
        poweredBy: 'Powered by ClearSky-OMEGA',
        platformCopyright: '© 2025 ClearSky Energy Solutions LLC · ClearSky-OMEGA platform'
      }
    },

    'csebuilders.com': {
      type: 'developer',
      orgId: 'csebuilders.com',
      clientName: 'ClearSky Energy Solutions',
      accountTier: 'Internal',
      tierLevel: 3,
      allowedDomain: 'csebuilders.com',
      logo: '/clearsky-logo.png',
      exportBrand: {
        logo: '/clearsky-logo.png',
        name: 'ClearSky Energy Solutions',
        poweredBy: 'ClearSky-OMEGA',
        platformCopyright: '© 2025 ClearSky Energy Solutions LLC · ClearSky-OMEGA platform'
      }
    },

    // ──────────────────── PARTNER (CROSS-ORG) TENANTS ────────────────────
    'amperagecapital.com': {
      type: 'partner',
      partnerKind: 'Financing Partner',
      orgId: 'amperagecapital.com',
      clientName: 'Amperage Capital',
      accountTier: 'Partner',
      allowedDomain: 'amperagecapital.com',
      portfolioOrgs: ['nextnrg.com'],
      logo: '/partner-logo.png',
      exportBrand: {
        logo: '/partner-logo.png',
        name: 'Amperage Capital',
        poweredBy: 'Powered by ClearSky-OMEGA',
        platformCopyright: '© 2025 ClearSky Energy Solutions LLC · ClearSky-OMEGA platform'
      }
    },

    'voltus.co': {
      type: 'partner',
      partnerKind: 'Aggregator',
      orgId: 'voltus.co',
      clientName: 'Voltus',
      accountTier: 'Partner',
      allowedDomain: 'voltus.co',
      portfolioOrgs: ['nextnrg.com'],
      logo: '/partner-logo.png',
      exportBrand: {
        logo: '/partner-logo.png',
        name: 'Voltus',
        poweredBy: 'Powered by ClearSky-OMEGA',
        platformCopyright: '© 2025 ClearSky Energy Solutions LLC · ClearSky-OMEGA platform'
      }
    }

  };

  function domainOf(email) {
    var parts = (email || '').split('@');
    return parts[1] ? parts[1].toLowerCase() : '';
  }

  function resolveWorkspace(email) {
    var d = domainOf(email);
    return (d && WORKSPACES.hasOwnProperty(d)) ? WORKSPACES[d] : null;
  }

  // Expose on the global object for every page to consume.
  root.OMEGA_WORKSPACES = WORKSPACES;
  root.OMEGA_domainOf = domainOf;
  root.OMEGA_resolveWorkspace = resolveWorkspace;
})(typeof window !== 'undefined' ? window : this);
