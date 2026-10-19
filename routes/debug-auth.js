const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const getSupabaseUrl = () => process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;

const decodeBase64 = (s) => {
  try {
    const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
};

router.post('/token-debug', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required in body' });

    const parts = (token || '').split('.');
    const header = parts[0] ? JSON.parse(decodeBase64(parts[0])) : null;
    const payload = parts[1] ? JSON.parse(decodeBase64(parts[1])) : null;

    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) return res.status(500).json({ error: 'SUPABASE_URL not configured' });

    const jwksUrls = [
      `${supabaseUrl.replace(/\/$/, '')}/.well-known/jwks.json`,
      `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
    ];

    const jwks = {};
    for (const u of jwksUrls) {
      try {
        const r = await fetch(u, { timeout: 3000 });
        if (r.ok) jwks[u] = await r.json();
        else jwks[u] = { status: r.status };
      } catch (e) {
        jwks[u] = { error: e.message };
      }
    }

    const jwkKids = {};
    Object.keys(jwks).forEach((k) => {
      try {
        if (jwks[k] && Array.isArray(jwks[k].keys)) jwkKids[k] = jwks[k].keys.map(x => x.kid);
        else jwkKids[k] = null;
      } catch (_) {
        jwkKids[k] = null;
      }
    });

    return res.json({ header, payload, jwkKids });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Extra debug route: expose Google audience list and lightweight runtime info
try {
  const { buildGoogleAudienceList } = require('../config/googleClients');
  router.get('/google-audiences', (req, res) => {
    try {
      const audiences = buildGoogleAudienceList(process.env || {});
      const commit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.COMMIT_SHA || null;
      return res.json({ audiences, nodeEnv: process.env.NODE_ENV || null, commit });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
} catch (e) {
  // If googleClients is not available, skip adding the route
}
