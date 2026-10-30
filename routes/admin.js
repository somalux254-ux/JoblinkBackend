const express = require('express');
const router = express.Router();
const { /* createClient */ } = require('@supabase/supabase-js');
const { getAdminClient } = require('../supabaseAdmin');
const ADMIN_EMAILS = ['campuslives254@gmail.com', 'paltechsomalux@gmail.com', 'paltechapp@gmail.com'];

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
    let isAuthenticated = false;

    if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.slice(7).trim();
      try {
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (!userErr && userData && userData.user && userData.user.id) {
          isAuthenticated = true;
          // Check profiles table for role
          const userId = userData.user.id;
          let { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('id, role')
            .eq('auth_user_id', userId)
            .maybeSingle();
          if (!profile && !profileErr) {
            ({ data: profile, error: profileErr } = await supabase
              .from('profiles')
              .select('id, role')
              .eq('id', userId)
              .maybeSingle());
          }
          const email = String(userData.user.email || '').trim().toLowerCase();
          const role = String(profile?.role || '').trim().toLowerCase();
          if (ADMIN_EMAILS.includes(email) || (!profileErr && ['admin', 'control', 'superadmin'].includes(role))) {
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

    if (!isAdmin) {
      return res.status(isAuthenticated ? 403 : 401).json({
        ok: false,
        error: isAuthenticated ? 'Admin access required.' : 'Unauthorized',
      });
    }

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
    const filteredUsers = (users || []).map(user => {
      const identities = Array.isArray(user.identities) ? user.identities : [];
      const googleIdentity = identities.find((identity) => identity.provider === 'google');
      const metadataCandidates = [
        googleIdentity?.identity_data,
        user.user_metadata,
        user.raw_user_meta_data,
        ...identities.map((identity) => identity.identity_data),
      ].filter((metadata) => metadata && typeof metadata === 'object');
      const firstString = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
      const firstName = firstString(...metadataCandidates.flatMap((metadata) => [
        metadata.given_name,
        metadata.first_name,
        metadata.firstName,
      ]));
      const lastName = firstString(...metadataCandidates.flatMap((metadata) => [
        metadata.family_name,
        metadata.last_name,
        metadata.lastName,
      ]));
      const displayName = firstString(
        ...metadataCandidates.flatMap((metadata) => [
          metadata.full_name,
          metadata.fullName,
          metadata.name,
          metadata.display_name,
        ]),
        [firstName, lastName].filter(Boolean).join(' ')
      );
      const googleAvatarUrl = firstString(
        googleIdentity?.identity_data?.picture,
        googleIdentity?.identity_data?.avatar_url,
        googleIdentity?.identity_data?.photoURL,
        googleIdentity?.identity_data?.image_url,
        ...[
          googleIdentity?.identity_data,
          user.user_metadata,
          user.raw_user_meta_data,
        ].filter((metadata) => metadata && typeof metadata === 'object').flatMap((metadata) => [
          metadata.picture,
          metadata.avatar_url,
          metadata.photoURL,
          metadata.photo_url,
          metadata.image_url,
          metadata.picture_url,
          metadata.profile_image_url,
          metadata.avatar,
        ])
      );

      return {
        id: user.id,
        email: user.email,
        full_name: displayName,
        display_name: displayName,
        avatar_url: googleAvatarUrl,
        google_avatar_url: googleAvatarUrl,
        email_confirmed_at: user.email_confirmed_at,
        last_sign_in_at: user.last_sign_in_at,
        created_at: user.created_at,
        updated_at: user.updated_at
      };
    });

    return res.json({ ok: true, users: filteredUsers });
  } catch (err) {
    console.error('[admin] Unexpected error:', err);
    return res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.patch('/users/:id/role', async (req, res) => {
  try {
    const supabase = getAdminClient();
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice(7).trim();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const superAdminEmails = ADMIN_EMAILS;
    const actorEmail = String(userData.user.email || '').trim().toLowerCase();
    const { data: actorProfile, error: actorProfileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (actorProfileError) {
      console.error('[admin] Error looking up role-management actor:', actorProfileError);
      return res.status(500).json({ error: 'Could not verify role-management access' });
    }
    const actorRole = String(actorProfile?.role || '').trim().toLowerCase();
    if (!superAdminEmails.includes(actorEmail) && !['control', 'admin', 'superadmin'].includes(actorRole)) {
      return res.status(403).json({ error: 'Only Control can change user roles' });
    }

    const { id } = req.params;
    const { role } = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (!['user', 'control', 'director', 'ceo', 'cfo', 'operations_manager'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    let { data: target, error: targetError } = await supabase
      .from('profiles')
      .select('id, auth_user_id, role')
      .eq('id', id)
      .maybeSingle();
    if (targetError) {
      console.error('[admin] Error looking up role target:', targetError);
      return res.status(500).json({ error: 'Could not load user profile' });
    }

    if (!target) {
      ({ data: target, error: targetError } = await supabase
        .from('profiles')
        .select('id, auth_user_id, role')
        .eq('auth_user_id', id)
        .maybeSingle());
      if (targetError) {
        console.error('[admin] Error looking up role target:', targetError);
        return res.status(500).json({ error: 'Could not load user profile' });
      }
    }

    if (target?.auth_user_id === userData.user.id || target?.id === userData.user.id || id === userData.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
    if (target?.role === 'superadmin') {
      return res.status(403).json({ error: 'A superadmin role cannot be changed' });
    }

    if (!target) {
      const { data: targetAuth, error: targetAuthError } = await supabase.auth.admin.getUserById(id);
      if (targetAuthError) {
        console.error('[admin] Error looking up role target auth user:', targetAuthError);
        return res.status(500).json({ error: 'Could not load user account' });
      }
      if (!targetAuth?.user) return res.status(404).json({ error: 'User account not found' });
      if (superAdminEmails.includes(String(targetAuth.user.email || '').trim().toLowerCase())) {
        return res.status(403).json({ error: 'A superadmin role cannot be changed' });
      }

      const { data: createdProfile, error: createProfileError } = await supabase
        .from('profiles')
        .insert({
          auth_user_id: targetAuth.user.id,
          email: targetAuth.user.email || null,
          role,
        })
        .select('id, role')
        .single();
      if (createProfileError) {
        console.error('[admin] Error creating role target profile:', createProfileError);
        return res.status(500).json({ error: 'Could not assign user role' });
      }
      return res.json({ ok: true, data: createdProfile });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', target.id)
      .select('id, role')
      .single();
    if (error) {
      console.error('[admin] Error updating user role:', error);
      return res.status(500).json({ error: 'Could not update user role' });
    }

    return res.json({ ok: true, data });
  } catch (err) {
    console.error('[admin] Unexpected role update error:', err);
    return res.status(500).json({ error: 'Could not update user role' });
  }
});

router.patch('/users/:id/tier', async (req, res) => {
  try {
    const supabase = getAdminClient();
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice(7).trim();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const superAdminEmails = ADMIN_EMAILS;
    const actorEmail = String(userData.user.email || '').trim().toLowerCase();
    const { data: actorProfile, error: actorProfileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (actorProfileError) {
      console.error('[admin] Error looking up tier-management actor:', actorProfileError);
      return res.status(500).json({ error: 'Could not verify tier-management access' });
    }
    const actorRole = String(actorProfile?.role || '').trim().toLowerCase();
    if (!superAdminEmails.includes(actorEmail) && !['control', 'admin', 'superadmin'].includes(actorRole)) {
      return res.status(403).json({ error: 'Only Control can change user subscription tiers' });
    }

    const { id } = req.params;
    const { subscription_tier: tier } = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (!['basic', 'premium', 'premium_pro'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    const subscriptionStartedAt = new Date().toISOString();
    const { data, error } = await supabase
      .from('profiles')
      .update({ subscription_tier: tier, subscription_started_at: subscriptionStartedAt })
      .eq('id', id)
      .select('id, subscription_tier, subscription_started_at, subscription_expires_at')
      .maybeSingle();
    if (error) {
      console.error('[admin] Error updating user subscription tier:', error);
      return res.status(500).json({ error: 'Could not update user subscription tier' });
    }
    if (!data) return res.status(404).json({ error: 'User profile not found' });

    return res.json({ ok: true, data });
  } catch (err) {
    console.error('[admin] Unexpected tier update error:', err);
    return res.status(500).json({ error: 'Could not update user subscription tier' });
  }
});

module.exports = router;
