const express = require('express');
const router = express.Router();
const { getAdminClient } = require('../supabaseAdmin');

const ADMIN_EMAILS = ['campuslives254@gmail.com', 'paltechsomalux@gmail.com', 'paltechapp@gmail.com'];

async function authorizeAdmin(req, supabase) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
      return { authorized: false, status: 401, error: 'Unauthorized' };
    }

    const token = authHeader.slice(7).trim();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return { authorized: false, status: 401, error: 'Unauthorized' };
    }

    const email = String(userData.user.email || '').trim().toLowerCase();
    let { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (!profile && !profileError) {
      ({ data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userData.user.id)
        .maybeSingle());
    }
    if (profileError) throw profileError;

    const role = String(profile?.role || '').trim().toLowerCase();
    if (!['admin', 'control', 'superadmin'].includes(role) && !ADMIN_EMAILS.includes(email)) {
      return { authorized: false, status: 403, error: 'Admin access required.' };
    }
    return { authorized: true, user: userData.user };
}

async function fetchFeedPlusSubmissions(supabase, profileId = null) {
    const pageSize = 1000;
    const submissions = [];
    for (let from = 0; ; from += pageSize) {
      let query = supabase
        .from('feedplus_submissions')
        .select('id, profile_id, email, message, page, category, priority, platform, problem, solution, attachments, submitted_at')
        .eq('page', 'settings/feedplus')
        .order('submitted_at', { ascending: false });
      if (profileId) query = query.eq('profile_id', profileId);
      const { data, error } = await query.range(from, from + pageSize - 1);
      if (error) throw error;
      submissions.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return submissions;
}

async function fetchFeedPlusSubmissionsForUser(supabase, user) {
  let { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!profile && !profileError) {
    ({ data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle());
  }
  if (profileError) throw profileError;

  const filters = [{ column: 'auth_user_id', value: user.id }];
  if (profile?.id) filters.push({ column: 'profile_id', value: profile.id });
  if (user.email) filters.push({ column: 'email', value: user.email, unlinkedOnly: true });

  const submissionSets = await Promise.all(filters.map(async ({ column, value, unlinkedOnly }) => {
    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      let query = supabase
        .from('feedplus_submissions')
        .select('id, email, message, category, priority, platform, problem, solution, attachments, submitted_at')
        .eq('page', 'settings/feedplus')
        .eq(column, value)
        .order('submitted_at', { ascending: false });
      if (unlinkedOnly) {
        query = query.is('auth_user_id', null).is('profile_id', null);
      }
      const { data, error } = await query.range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }));

  const uniqueSubmissions = new Map();
  submissionSets.flat().forEach((submission) => uniqueSubmissions.set(submission.id, submission));
  return Array.from(uniqueSubmissions.values())
    .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0));
}

router.get('/feedplus', async (req, res) => {
    try {
      const supabase = getAdminClient();
      const authorization = await authorizeAdmin(req, supabase);
      if (!authorization.authorized) {
        return res.status(authorization.status).json({ ok: false, error: authorization.error });
      }
      const submissions = await fetchFeedPlusSubmissions(supabase);
      return res.json({ ok: true, submissions });
    } catch (err) {
      console.error('FeedPlus submissions fetch error:', err);
      return res.status(500).json({ ok: false, error: 'Failed to load FeedPlus submissions.' });
    }
});

router.get('/feedplus/count', async (req, res) => {
  try {
    const supabase = getAdminClient();
    const authorization = await authorizeAdmin(req, supabase);
    if (!authorization.authorized) {
      return res.status(authorization.status).json({ ok: false, error: authorization.error });
    }

    const { count, error } = await supabase
      .from('feedplus_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('page', 'settings/feedplus');
    if (error) throw error;
    return res.json({ ok: true, count: count || 0 });
  } catch (err) {
    console.error('FeedPlus submissions count fetch error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to load FeedPlus submissions count.' });
  }
});

router.get('/feedplus/mine', async (req, res) => {
  try {
    const supabase = getAdminClient();
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ ok: false, error: 'Sign in to view your FeedPlus submissions.' });
    }

    const token = authHeader.slice(7).trim();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return res.status(401).json({ ok: false, error: 'Your session is invalid. Sign in again.' });
    }

    const submissions = await fetchFeedPlusSubmissionsForUser(supabase, userData.user);
    return res.json({ ok: true, submissions });
  } catch (err) {
    console.error('Sender FeedPlus history fetch error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to load your FeedPlus submissions.' });
  }
});

router.get('/feedplus/profile/:profileId', async (req, res) => {
    try {
      const { profileId } = req.params;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) {
        return res.status(400).json({ ok: false, error: 'Invalid profile ID.' });
      }

      const supabase = getAdminClient();
      const authorization = await authorizeAdmin(req, supabase);
      if (!authorization.authorized) {
        return res.status(authorization.status).json({ ok: false, error: authorization.error });
      }
      const submissions = await fetchFeedPlusSubmissions(supabase, profileId);
      return res.json({ ok: true, submissions });
    } catch (err) {
      console.error('FeedPlus profile history fetch error:', err);
      return res.status(500).json({ ok: false, error: "Failed to load this user's FeedPlus history." });
    }
});

/**
 * POST /api/feedback
 * Accepts user feedback from the app and logs it for admin review.
 */
router.post('/', async (req, res) => {
  try {
    const {
      message,
      page,
      email,
      category,
      rating,
      priority,
      platform,
      problem,
      solution,
      attachments
    } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Feedback message is required.' });
    }

    let supabase = null;
    let profileId = null;
    let authUserId = null;
    let submitterEmail = email || null;
    if (page === 'settings/feedplus') {
      supabase = getAdminClient();
      const authHeader = req.headers.authorization;
      if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
        return res.status(401).json({ ok: false, error: 'Sign in to submit FeedPlus feedback.' });
      }
      const token = authHeader.slice(7).trim();
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData?.user?.id) {
        return res.status(401).json({ ok: false, error: 'Your session is invalid. Sign in again.' });
      }

      authUserId = userData.user.id;
      submitterEmail = userData.user.email || null;
      let { data: senderProfile, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', userData.user.id)
        .maybeSingle();
      if (!senderProfile && !profileError) {
        ({ data: senderProfile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', userData.user.id)
          .maybeSingle());
      }
      if (profileError) throw profileError;
      profileId = senderProfile?.id || null;
    }

    const feedbackEntry = {
      message: message.trim(),
      page: page || null,
      email: submitterEmail,
      category: typeof category === 'string' ? category.slice(0, 120) : null,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
      priority: ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : null,
      platform: ['mobile-app', 'mobile-website', 'desktop'].includes(platform) ? platform : null,
      problem: typeof problem === 'string' ? problem.trim().slice(0, 3000) : null,
      solution: typeof solution === 'string' ? solution.trim().slice(0, 3000) : null,
      attachments: Array.isArray(attachments)
        ? attachments.slice(0, 5).filter((attachment) => (
          attachment &&
          typeof attachment.url === 'string' &&
          typeof attachment.name === 'string' &&
          typeof attachment.type === 'string'
        )).map(({ name, type, url }) => ({
          name: name.slice(0, 255),
          type: type.slice(0, 100),
          url: url.slice(0, 2048),
        }))
        : [],
      submittedAt: new Date().toISOString()
    };

    if (feedbackEntry.page === 'settings/feedplus') {
      const { data: submission, error } = await supabase
        .from('feedplus_submissions')
        .insert({
          auth_user_id: authUserId,
          profile_id: profileId,
          message: feedbackEntry.message,
          page: feedbackEntry.page,
          email: feedbackEntry.email,
          category: feedbackEntry.category,
          priority: feedbackEntry.priority,
          platform: feedbackEntry.platform,
          problem: feedbackEntry.problem,
          solution: feedbackEntry.solution,
          attachments: feedbackEntry.attachments,
          submitted_at: feedbackEntry.submittedAt,
        })
        .select('id, email, message, category, priority, platform, problem, solution, attachments, submitted_at')
        .single();
      if (error) throw error;
      return res.json({ ok: true, message: 'Thank you — your review has been saved to your submissions.', submission });
    }

    

    return res.json({ ok: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    console.error('Feedback submission error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to submit feedback.' });
  }
});

module.exports = router;
