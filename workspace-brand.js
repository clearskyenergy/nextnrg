/*
  ═══════════════════════════════════════════════════════════════════════════════
  ClearSky-OMEGA · Workspace Branding Module
  © 2025 ClearSky Energy Solutions LLC. All rights reserved.
  Proprietary and Confidential. Author: Tommy Gilmer.

  Drop <script src="/workspace-brand.js"></script> into each tool page
  (proforma.html, sales-proposal.html, permit.html, editor.html, etc.) BEFORE
  the tool's own script. It exposes window.OMEGA_WORKSPACE and helper functions
  so every customer-facing export (proposal, permit set, PDF) is branded to the
  client — here, NextNRG — while the platform and code remain ClearSky-OMEGA.

  This is NextNRG's build. For a different client deployment, change WORKSPACE.
  ═══════════════════════════════════════════════════════════════════════════════
*/
(function () {
  var WORKSPACE = {
    orgId: 'nextnrg.com',
    clientName: 'NextNRG',
    accountTier: 'Enterprise',
    allowedDomain: 'nextnrg.com',
    exportBrand: {
      logo: '/nextnrg-logo.png',                 // customer-facing logo
      name: 'NextNRG',
      poweredBy: 'Powered by ClearSky-OMEGA',
      platformCopyright: '\u00A9 2025 ClearSky Energy Solutions LLC \u00B7 ClearSky-OMEGA platform'
    }
  };

  window.OMEGA_WORKSPACE = WORKSPACE;

  // ── Helpers every tool can call when building an export ──────────────────────

  // Returns an <img> HTML string for the client logo (use in HTML/PDF headers).
  window.omegaExportLogo = function (heightPx) {
    var h = heightPx || 48;
    return '<img src="' + WORKSPACE.exportBrand.logo + '" alt="' +
      WORKSPACE.exportBrand.name + '" style="height:' + h + 'px;width:auto;display:block">';
  };

  // Returns the standard export footer HTML: "Powered by ClearSky-OMEGA" + your IP line.
  window.omegaExportFooter = function () {
    var b = WORKSPACE.exportBrand;
    return '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #e5e5e5;' +
      'font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#8a8a8a;' +
      'display:flex;justify-content:space-between;gap:12px;">' +
      '<span>' + b.poweredBy + '</span>' +
      '<span>' + b.platformCopyright + '</span>' +
      '</div>';
  };

  // Returns the client display name (for cover pages, titles, filenames).
  window.omegaClientName = function () { return WORKSPACE.exportBrand.name; };

  // Suggested export filename prefix, e.g. "NextNRG_Proposal_..."
  window.omegaFilePrefix = function () {
    return WORKSPACE.exportBrand.name.replace(/[^A-Za-z0-9]/g, '');
  };
})();
