const express = require('express');
const router = express.Router();
const { getAdminClient } = require('../supabaseAdmin');
const cache = require('../cache');
const client = require('prom-client');
const dbQueries = new client.Counter({ name: 'db_queries_total', help: 'Total DB queries executed' });

/**
 * GET /api/utils/followers-count?user_id=<id>
 * Returns a cached follower count for a user. Uses profiles.followers when present,
 * otherwise counts the follows rows. Cached for short TTL to reduce DB load.
 */
router.get('/followers-count', async (req, res) => {
  try {
    const userId = req.query.user_id || req.query.userId;
    if (!userId) return res.status(400).json({ ok: false, error: 'user_id required' });

    const cacheKey = `followers_count:${userId}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null && cached !== undefined) {
      return res.json({ ok: true, count: Number(cached), cached: true, source: 'cache' });
    }

    const supabase = getAdminClient();

    // Try profiles.followers
    dbQueries.inc();
    const { data: profileData, error: profileErr } = await supabase
      .from('profiles')
      .select('followers')
      .eq('id', userId)
      .limit(1)
      .maybeSingle();

    if (!profileErr && profileData && typeof profileData.followers === 'number') {
      const count = Number(profileData.followers);
      await cache.set(cacheKey, count, 30);
      return res.json({ ok: true, count, cached: false, source: 'profiles' });
    }

    // Fallback to counting follows rows (use HEAD/count to avoid payload)
    dbQueries.inc();
    const { count, error: countErr } = await supabase
      .from('follows')
      .select('id', { count: 'exact', head: true })
      .eq('followed_id', userId);

    if (countErr) {
      console.warn('[utils] followers-count error', countErr);
      return res.status(500).json({ ok: false, error: 'DB error' });
    }
    const finalCount = Number(count || 0);
    await cache.set(cacheKey, finalCount, 30);
    return res.json({ ok: true, count: finalCount, cached: false, source: 'fallback' });
  } catch (e) {
    console.error('[utils] followers-count exception', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.get('/profile', async (req, res) => {
  try {
    const id = req.query.id || req.query.user_id;
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const cacheKey = `profile:id:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ ok: true, profile: cached, cached: true, source: 'cache' });
    }

    const supabase = getAdminClient();
    dbQueries.inc();
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, full_name, avatar_url, followers')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.warn('[utils] profile error', error);
      return res.status(500).json({ ok: false, error: 'DB error' });
    }
    await cache.set(cacheKey, data, 60);
    return res.json({ ok: true, profile: data, cached: false });
  } catch (e) {
    console.error('[utils] profile exception', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

module.exports = router;
