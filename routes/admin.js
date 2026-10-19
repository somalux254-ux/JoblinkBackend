const express = require('express');
const router = express.Router();
const { /* createClient */ } = require('@supabase/supabase-js');
const { getAdminClient } = require('../supabaseAdmin');

/**
 * GET /api/admin/authenticated-users
 * Query auth.users using the Supabase service role key.
 * Protect this endpoint by requiring an `x-admin-secret` header
 * (value must match process.env.ADMIN_SECRET).
 * Supports pagination via `page` (0-based) and `page_size` query params.
 */
router.get('/authenticated-users', async (req, res) => {
  try {
    let supabase;
    try {
      supabase = getAdminClient();
    } catch (e) {
      console.error('Supabase config missing or invalid', e?.message || e);
      return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });
    }

    // First, try to authorize via Authorization: Bearer <access_token>
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    let isAdmin = false;

    if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.slice(7).trim();
      try {
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (!userErr && userData && userData.user && userData.user.id) {
          // Check profiles table for role
          const userId = userData.user.id;
          const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('id, role')
            .eq('id', userId)
            .maybeSingle();
          if (!profileErr && profile && (profile.role === 'admin' || profile.role === 'superadmin')) {
            isAdmin = true;
          }
        }
      } catch (e) {
        console.warn('[admin] Error validating access token:', e?.message || e);
      }
    }

    // Fallback: allow admin secret via header or query param for non-production/dev scenarios
    const adminSecret = process.env.ADMIN_SECRET;
    const providedSecret = req.headers['x-admin-secret'] || req.query.admin_secret;
    if (!isAdmin && adminSecret && providedSecret && providedSecret === adminSecret) {
      isAdmin = true;
    }

    if (!isAdmin) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const page = Math.max(0, parseInt(req.query.page || '0', 10));
    const pageSize = Math.min(Math.max(1, parseInt(req.query.page_size || '1000', 10)), 5000);
    const from = page * pageSize;
    const to = from + pageSize - 1;

    // Use Supabase Admin API to list users (service role key grants access)
    const { data: { users }, error } = await supabase.auth.admin.listUsers({
      perPage: pageSize,
      page: page + 1  // Admin API uses 1-based pages
    });

    if (error) {
      console.error('[admin] Error fetching auth.users:', error);
      return res.status(500).json({ ok: false, error: error.message || error });
    }

    // Return only essential fields to frontend
    const filteredUsers = (users || []).map(user => ({
      id: user.id,
      email: user.email,
      email_confirmed_at: user.email_confirmed_at,
      last_sign_in_at: user.last_sign_in_at,
      created_at: user.created_at,
      updated_at: user.updated_at
    }));

    return res.json({ ok: true, users: filteredUsers });
  } catch (err) {
    console.error('[admin] Unexpected error:', err);
    return res.status(500).json({ ok: false, error: err.message || err });
  }
});

module.exports = router;
