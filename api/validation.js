// Vercel serverless function: /api/validation
// Receives a permit-set "export for validation & stamp approval" request from
// the NextNRG SiteMap Designer, generates a validation/invoice tracking ID,
// and emails the package (CSV data attached, tracking details in the subject)
// to the AP inbox so the third-party engineering partner can PE-stamp it.
//
// The partner company is intentionally NOT named anywhere in this flow.
//
// SETUP (one time), in Vercel -> Project -> Settings -> Environment Variables:
//   RESEND_API_KEY   = <your Resend API key>      (https://resend.com)
//   VALIDATION_TO    = ap@clearsky-usa.com        (AP / tracking inbox)
//   VALIDATION_FROM  = validation@nextnrg.com     (verified sender domain)
//   PARTNER_TO       = <the engineering partner's intake email>  (optional)
// Redeploy after adding them.
//
// REQUEST (POST JSON):
//   { projectId, projectName, address, senderName, senderEmail, org,
//     market, offtaker, csv (string), summary (object) }
// RESPONSE (JSON):
//   { ok:true, validationId, projectId }  |  { error }

function pad(n){ return n < 10 ? '0' + n : '' + n; }
function genValidationId(){
  var d = new Date();
  var ymd = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  var rand = Math.floor(1000 + Math.random() * 9000);
  return 'NX-VAL-' + ymd + '-' + rand;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

    var projectId   = (body && body.projectId)   || 'unknown';
    var projectName = (body && body.projectName) || 'Untitled Project';
    var address     = (body && body.address)     || '';
    var senderName  = (body && body.senderName)  || 'NextNRG User';
    var senderEmail = (body && body.senderEmail) || '';
    var org         = (body && body.org)         || 'NextNRG';
    var market      = (body && body.market)      || '';
    var offtaker    = (body && body.offtaker)    || '';
    var csv         = (body && body.csv)         || '';
    var summary     = (body && body.summary)     || {};

    var validationId = genValidationId();

    var TO   = process.env.VALIDATION_TO   || 'ap@clearsky-usa.com';
    var FROM = process.env.VALIDATION_FROM || 'validation@nextnrg.com';
    var PARTNER = process.env.PARTNER_TO || '';
    var key  = process.env.RESEND_API_KEY;

    // Subject line carries the tracking data at a glance.
    var subject = validationId + ' \u00b7 Validation & Stamp \u00b7 ' + projectName +
                  ' \u00b7 Project ' + projectId + ' \u00b7 from ' + org;

    var htmlBody =
      '<h2>Engineering Validation &amp; Stamp Approval Request</h2>' +
      '<table style="font-family:Arial,sans-serif;font-size:13px;border-collapse:collapse">' +
      row('Validation / Invoice ID', validationId) +
      row('Project ID', projectId) +
      row('Project name', projectName) +
      row('Site address', address) +
      row('Market', market) +
      row('Off-taker', offtaker) +
      row('Submitted by', senderName + (senderEmail ? ' &lt;' + senderEmail + '&gt;' : '')) +
      row('From workspace', org) +
      row('System', (summary.mwh != null ? summary.mwh + ' MWh / ' : '') + (summary.mw != null ? summary.mw + ' MW' : '')) +
      '</table>' +
      '<p style="font-family:Arial,sans-serif;font-size:12px;color:#555">' +
      'The permit-set data is attached as a CSV. Please validate, apply the PE stamp, ' +
      'and return with the invoice referencing <b>' + validationId + '</b>.</p>';

    function row(k, v){
      return '<tr><td style="padding:4px 10px;border:1px solid #ddd;font-weight:700">' + k +
             '</td><td style="padding:4px 10px;border:1px solid #ddd">' + (v || '\u2014') + '</td></tr>';
    }

    // Build recipient list (AP inbox always; partner intake if configured).
    var toList = [TO];
    if (PARTNER) toList.push(PARTNER);

    // CSV as a base64 attachment.
    var csvB64 = Buffer.from(csv || ('Validation ID,' + validationId + '\nProject ID,' + projectId), 'utf8').toString('base64');
    var attachmentName = validationId + '_' + String(projectName).replace(/[^a-z0-9]/gi, '-') + '.csv';

    if (!key) {
      // No mail provider configured yet -- still return the ID so the UI can
      // track it; the operator can wire RESEND_API_KEY later.
      res.status(200).json({
        ok: true, validationId: validationId, projectId: projectId,
        warning: 'RESEND_API_KEY not set -- email not sent, but ID generated for tracking.'
      });
      return;
    }

    var mailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: toList,
        reply_to: senderEmail || undefined,
        subject: subject,
        html: htmlBody,
        attachments: [{ filename: attachmentName, content: csvB64 }]
      })
    });

    if (!mailResp.ok) {
      var errText = await mailResp.text();
      res.status(mailResp.status).json({ error: 'Mail send failed: ' + errText.slice(0, 300), validationId: validationId });
      return;
    }

    res.status(200).json({ ok: true, validationId: validationId, projectId: projectId });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
