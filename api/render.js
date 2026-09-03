/* ═══════════════════════════════════════════════════════════════════════════
   ClearSky OMEGA · /api/render
   © 2026 ClearSky Energy Solutions LLC. Proprietary and Confidential.

   Turns the Site Visualizer's 3D snapshot into the kind of client-facing
   image an architectural visualiser would charge four figures for.

   ─────────────────────────────────────────────────────────────────────────
   WHY gpt-image-1
   ─────────────────────────────────────────────────────────────────────────
   Because it is the model that made the picture you liked. That ChatGPT
   panorama came out of this family, and no amount of prompt work on a
   different model reproduces another model's look. If the goal is "that
   aesthetic", the shortest path is that model.

   It is also the strongest of the current crop at INSTRUCTION FOLLOWING,
   which is the property this whole approach depends on. The render is only
   trustworthy if "do not move any solar array" is actually obeyed.

   PROVIDER is switchable. Vertex Imagen is kept as a second path because
   your Maps billing already lives in Google Cloud and some organisations
   would rather not add a vendor. Set RENDER_PROVIDER=vertex to use it.

   ─────────────────────────────────────────────────────────────────────────
   THIS IS AN EDIT, NOT A GENERATION
   ─────────────────────────────────────────────────────────────────────────
   The 3D snapshot goes to /images/edits as the source. Massing, array
   footprint, row pitch, equipment position and sun angle are already
   correct because the site model computed them. The model is asked for
   materials, light and context — not for a site.

   That distinction is the whole reason this can go in front of a client.
   A text-to-image render of "a solar carport in Miami" is a stock photo
   with your name on it. This is your site.

   ─────────────────────────────────────────────────────────────────────────
   SETUP
   ─────────────────────────────────────────────────────────────────────────
     OPENAI_API_KEY     required
     RENDER_ORIGINS     comma-separated hosts allowed to call this
     RENDER_PROVIDER    'openai' (default) or 'vertex'
     RENDER_QUALITY     'high' (default) | 'medium' | 'low'

   The key stays here. It must never reach the browser — that is the entire
   reason this file exists rather than the editor calling OpenAI directly.
   ═══════════════════════════════════════════════════════════════════════════ */

const BUILD    = '2026-09-02.googleai-default';
/* Google by default. It needs no organisation verification, it bills to the
   Cloud project the Maps key already runs on, and it is therefore the one
   that can be working tonight. Set RENDER_PROVIDER=openai to switch once
   OpenAI verification clears. */
const PROVIDER = (process.env.RENDER_PROVIDER || 'googleai').toLowerCase();
const QUALITY  = process.env.RENDER_QUALITY || 'high';

const ALLOWED_ORIGINS = (process.env.RENDER_ORIGINS
  || 'https://osa.clearskyomega.com,https://alpha.clearskyomega.com,'
   + 'https://nextnrg.csebuilders.com,https://tools.csebuilders.com')
  .split(',').map(s => s.trim()).filter(Boolean);

function applyCors(req, res) {
  if (!res || typeof res.setHeader !== 'function') return;
  const o = req && req.headers && (req.headers.origin || req.headers.Origin);
  if (o && (ALLOWED_ORIGINS.indexOf(o) >= 0 || /^https?:\/\/localhost(:\d+)?$/.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function stripDataUrl(s) {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(s || ''));
  return m ? m[1] : null;
}

/* Aspect → the sizes gpt-image-1 actually accepts. Anything else is a 400,
   and "invalid size" is an unhelpful thing to show somebody who picked a
   shape from a dropdown. */
function sizeFor(aspect) {
  if (aspect === '1:1')  return '1024x1024';
  if (aspect === '9:16') return '1024x1536';
  return '1536x1024';                 /* the default for a site view */
}

/* ── OPENAI ────────────────────────────────────────────────────────────── */
async function viaOpenAI(b64img, prompt, aspect) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw Object.assign(new Error('OPENAI_API_KEY is not set on this deployment.'), { code: 500 });

  const bytes = Buffer.from(b64img, 'base64');
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('image', new Blob([bytes], { type: 'image/png' }), 'site.png');
  form.append('prompt', prompt);
  form.append('size', sizeFor(aspect));
  form.append('quality', QUALITY);
  form.append('n', '1');
  /* No response_format: gpt-image-1 always returns b64_json, and sending
     the parameter is an error rather than a no-op. */

  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key },
    body: form
  });
  const j = await r.json().catch(() => null);

  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || ('OpenAI returned ' + r.status);
    /* Name the failures that actually happen, rather than handing a raw
       provider error to somebody who just wanted a picture. */
    let hint = '';
    if (r.status === 401) hint = ' The key is rejected \u2014 check OPENAI_API_KEY.';
    if (r.status === 403) hint = ' gpt-image-1 needs a verified organisation on the OpenAI account.';
    if (r.status === 429) hint = ' Rate limited or out of credit.';
    if (/safety|moderation/i.test(msg)) hint = ' The safety filter refused it \u2014 usually a false '
      + 'positive on aerial imagery. Try again, or use the "diagram" style.';
    throw Object.assign(new Error(msg + hint), { code: r.status });
  }

  const out = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!out) throw Object.assign(new Error('OpenAI returned no image.'), { code: 502 });
  return { image: 'data:image/png;base64,' + out, model: 'gpt-image-1' };
}

/* ── GOOGLE AI STUDIO ──────────────────────────────────────────────────
   The path that needs no service account.

   Google now enforces iam.disableServiceAccountKeyCreation on new
   organisations by default, so the Vertex route below can be blocked
   before it starts — and getting it unblocked means an Organization
   Policy Administrator changing an org-wide security setting to make one
   render button work. That is the wrong trade.

   AI Studio issues a plain API key against the same Google account, with
   no service account, no JSON, and no org policy involved. The model is
   Gemini 2.5 Flash Image, which takes an image IN and returns an image
   OUT — so the control-image approach is intact, which is the part that
   actually matters.

     GOOGLE_AI_KEY   from aistudio.google.com/apikey

   The key stays here, exactly as with the others. */
async function viaGoogleAI(b64img, prompt) {
  const key = process.env.GOOGLE_AI_KEY;
  if (!key) throw Object.assign(new Error('GOOGLE_AI_KEY is not set on this deployment.'), { code: 500 });

  const model = process.env.GOOGLE_AI_MODEL || 'gemini-2.5-flash-image';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
            + model + ':generateContent?key=' + encodeURIComponent(key);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: b64img } },
          { text: prompt }
        ]
      }],
      generationConfig: { responseModalities: ['IMAGE'] }
    })
  });

  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || ('Google AI returned ' + r.status);
    let hint = '';
    if (r.status === 400 && /API key/i.test(msg)) hint = ' Check GOOGLE_AI_KEY.';
    if (r.status === 403) hint = ' Enable the Generative Language API on the key\u2019s project, '
      + 'or the key is restricted to other APIs.';
    if (r.status === 429) hint = ' Rate limited \u2014 the free tier is a few images a minute.';
    throw Object.assign(new Error(msg + hint), { code: r.status });
  }

  /* The image comes back as an inline_data part among the candidate's
     parts; there may be a text part alongside it, so find it by type
     rather than by position. */
  let out = null;
  try {
    const parts = j.candidates[0].content.parts || [];
    for (const p of parts) {
      const d = p.inlineData || p.inline_data;
      if (d && d.data) { out = d.data; break; }
    }
  } catch (e) {}
  if (!out) {
    const why = (j && j.candidates && j.candidates[0] && j.candidates[0].finishReason) || '';
    throw Object.assign(new Error('Google AI returned no image'
      + (why ? ' (' + why + ')' : '') + '. Usually a safety filter.'), { code: 502 });
  }
  return { image: 'data:image/png;base64,' + out, model: model };
}

/* ── VERTEX (alternative) ──────────────────────────────────────────────── */
let _tok = null, _tokExp = 0;
async function vertexToken() {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT is not set.');
  const sa = JSON.parse(raw);
  const crypto = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
                      aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
  const s = crypto.createSign('RSA-SHA256'); s.update(head + '.' + claim);
  const sig = s.sign(sa.private_key.replace(/\\n/g, '\n'), 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                assertion: head + '.' + claim + '.' + sig })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Vertex token exchange failed.');
  _tok = j.access_token; _tokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return _tok;
}

async function viaVertex(b64img, prompt, aspect) {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const loc = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
  if (!project) throw Object.assign(new Error('GOOGLE_CLOUD_PROJECT is not set.'), { code: 500 });
  const token = await vertexToken();
  const model = process.env.IMAGEN_MODEL || 'imagen-3.0-capability-001';
  const r = await fetch('https://' + loc + '-aiplatform.googleapis.com/v1/projects/' + project
    + '/locations/' + loc + '/publishers/google/models/' + model + ':predict', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt: prompt, referenceImages: [{
        referenceType: 'REFERENCE_TYPE_CONTROL', referenceId: 1,
        referenceImage: { bytesBase64Encoded: b64img },
        controlImageConfig: { controlType: 'CONTROL_TYPE_SCRIBBLE', enableControlImageComputation: true }
      }]}],
      parameters: { sampleCount: 1, aspectRatio: aspect || '16:9', guidanceScale: 22,
                    personGeneration: 'dont_allow', addWatermark: false }
    })
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((j && j.error && j.error.message) || ('Vertex ' + r.status)), { code: r.status });
  const out = j && j.predictions && j.predictions[0] && j.predictions[0].bytesBase64Encoded;
  if (!out) throw Object.assign(new Error('Vertex returned no image (usually a safety filter).'), { code: 502 });
  return { image: 'data:image/png;base64,' + out, model: model };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    /* Probe the credential rather than asserting it is fine. */
    let cred = 'not attempted';
    if (PROVIDER === 'openai') {
      cred = process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY present' : 'FAILED: OPENAI_API_KEY not set';
    } else if (PROVIDER === 'vertex') {
      try { await vertexToken(); cred = 'ok'; } catch (e) { cred = 'FAILED: ' + e.message; }
    } else {
      cred = process.env.GOOGLE_AI_KEY ? 'GOOGLE_AI_KEY present' : 'FAILED: GOOGLE_AI_KEY not set';
    }
    return res.status(200).json({
      ok: true, build: BUILD, provider: PROVIDER,
      model: PROVIDER === 'openai' ? 'gpt-image-1'
           : PROVIDER === 'vertex' ? (process.env.IMAGEN_MODEL || 'imagen-3.0-capability-001')
           : (process.env.GOOGLE_AI_MODEL || 'gemini-2.5-flash-image'),
      quality: QUALITY, credential: cred, origins: ALLOWED_ORIGINS.length,
      note: 'Image edit, not generation. The 3D snapshot is the source; the prompt supplies '
          + 'materials and light only. Every result is labelled ARTIST\u2019S IMPRESSION in the '
          + 'editor before it is shown \u2014 it is a picture, not a drawing.'
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST.' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const img = stripDataUrl(body.image);
  const prompt = String(body.prompt || '').slice(0, 3000);

  if (!img) return res.status(400).json({ build: BUILD,
    error: 'No control image. Render from the Site Visualizer \u2014 without the snapshot this '
         + 'would invent a site rather than draw yours.' });
  if (!prompt) return res.status(400).json({ build: BUILD, error: 'No prompt supplied.' });

  try {
    const out = PROVIDER === 'vertex'  ? await viaVertex(img, prompt, body.aspectRatio)
              : PROVIDER === 'openai'  ? await viaOpenAI(img, prompt, body.aspectRatio)
              :                          await viaGoogleAI(img, prompt);
    return res.status(200).json({ build: BUILD, provider: PROVIDER, model: out.model,
                                  image: out.image, prompt: prompt });
  } catch (e) {
    return res.status(e && e.code ? e.code : 502).json({
      build: BUILD, provider: PROVIDER,
      error: 'Render failed: ' + ((e && e.message) || 'unknown') });
  }
};
