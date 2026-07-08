// Vercel serverless function: /api/stencil
// Proxies a Google Gemini 2.5 Flash Image ("Nano Banana") image-to-image call
// so the API key stays server-side and the browser avoids CORS.
//
// SETUP (one time):
//   1. Put this file at  api/stencil.js  in the same GitHub repo that deploys
//      the ClearSky SiteMap Designer to Vercel.
//   2. In Vercel -> Project -> Settings -> Environment Variables, add:
//         GEMINI_API_KEY = <your AIza... key from aistudio.google.com>
//      (Redeploy after adding it.)
//   3. That's it. The tool calls /api/stencil automatically; no key in the browser.
//
// REQUEST  (POST JSON):  { "image": "data:image/png;base64,...."  , "prompt": "..." (optional) }
// RESPONSE (JSON):       { "image": "data:image/png;base64,...." }  or  { "error": "..." }

const DEFAULT_PROMPT =
  'Redraw this satellite/aerial photo as a PURE BLACK-AND-WHITE LINE DRAWING - ' +
  'a vector-style CAD site plan. Use ONLY solid black outlines (1-2px strokes) on ' +
  'a PURE WHITE (#FFFFFF) background. Two-tone only: black lines, white fill, NO ' +
  'gray tones, NO shading, NO gradients, NO photographic texture. Trace edges of ' +
  'buildings/rooftops, road and driveway edges, parking lot outlines and stall ' +
  'lines, sidewalks, curbs, and property lines. Interiors stay white - do not fill ' +
  'with gray or black. Omit grass, trees, landscaping, shadows, cars, and color. ' +
  'Result should look like a hand-inked engineering site plan, not a grayscale ' +
  'photo. Outlines only, no text labels.';

module.exports = async function handler(req, res) {
  // CORS: allow the tool (any origin) to call this proxy.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  var key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(500).json({ error: 'GEMINI_API_KEY not set on the server' }); return; }

  try {
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    var dataUrl = body && body.image;
    var prompt  = (body && body.prompt) || DEFAULT_PROMPT;
    if (!dataUrl) { res.status(400).json({ error: 'missing image' }); return; }

    var m = /^data:(image\/\w+);base64,(.*)$/.exec(dataUrl);
    if (!m) { res.status(400).json({ error: 'image must be a data URL' }); return; }
    var mediaType = m[1], rawB64 = m[2];

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent';
    var gResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inline_data: { mime_type: mediaType, data: rawB64 } }
        ] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });

    if (!gResp.ok) {
      var errText = await gResp.text();
      res.status(gResp.status).json({ error: 'Gemini ' + gResp.status + ': ' + errText.slice(0, 300) });
      return;
    }
    var data = await gResp.json();
    var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    var img = null;
    for (var i = 0; i < parts.length; i++) {
      var inl = parts[i].inlineData || parts[i].inline_data;
      if (inl && inl.data) { img = inl; break; }
    }
    if (!img) { res.status(502).json({ error: 'no image returned by Gemini' }); return; }
    var mt = img.mimeType || img.mime_type || 'image/png';
    res.status(200).json({ image: 'data:' + mt + ';base64,' + img.data });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
