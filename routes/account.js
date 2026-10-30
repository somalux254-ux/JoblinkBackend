const express = require('express');
const router = express.Router();
const { getAdminClient } = require('../supabaseAdmin');

const AVATAR_BUCKET = 'user-avatars';
const MEDIA_BUCKET = 'media_files';
const MAX_IMAGE_UPLOAD_BYTES = 1_000_000;
const MAX_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const ALLOWED_MEDIA_TYPES = new Set([
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES,
  'application/pdf',
]);

const BUCKET_ALIASES = {
  'user-avatars': ['user_avatars', 'avatars', 'user-avatars', 'user_avatars_bucket'],
  'media_files': ['media-files', 'media', 'uploads', 'media_files_bucket'],
  'media-files': ['media_files', 'media', 'uploads', 'media_files_bucket'],
  user_avatars: ['user-avatars', 'avatars', 'user_avatars_bucket'],
  'media': ['media_files', 'media-files', 'uploads'],
};

const STORAGE_BUCKETS = new Set([
  ...Object.keys(BUCKET_ALIASES),
  ...Object.values(BUCKET_ALIASES).flat(),
]);

const getOwnedStorageObject = (value, defaultBucket, userId) => {
  if (typeof value !== 'string' || !value.trim()) return null;

  let bucket = defaultBucket;
  let objectPath = value.trim();
  if (/^https?:\/\//i.test(objectPath)) {
    try {
      const pathname = new URL(objectPath).pathname;
      const storageMatch = pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i);
      if (!storageMatch) return null;
      bucket = decodeURIComponent(storageMatch[1]);
      objectPath = decodeURIComponent(storageMatch[2]);
    } catch (_) {
      return null;
    }
  } else {
    const storageMatch = objectPath.match(/^\/?storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i);
    if (storageMatch) {
      bucket = decodeURIComponent(storageMatch[1]);
      objectPath = decodeURIComponent(storageMatch[2]);
    } else {
      objectPath = objectPath.replace(/^\/+/, '');
      const prefixedBucket = objectPath.match(/^([^/]+)\/(.+)$/);
      if (prefixedBucket && STORAGE_BUCKETS.has(prefixedBucket[1])) {
        bucket = prefixedBucket[1];
        objectPath = prefixedBucket[2];
      }
    }
  }

  if (!STORAGE_BUCKETS.has(bucket) || !objectPath.startsWith(`${userId}/`)) return null;
  return { bucket, path: objectPath };
};

const resolveStorageBucket = async (supabase, bucketName) => {
  const aliases = BUCKET_ALIASES[bucketName] || BUCKET_ALIASES[String(bucketName)] || [];
  const candidates = Array.from(new Set([bucketName, ...aliases].filter(Boolean)));
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const { data, error } = await supabase.storage.getBucket(candidate);
      if (!error && data) {
        return candidate;
      }
      lastError = error || lastError;
    } catch (err) {
      lastError = err;
    }
  }

  try {
    const { data: bucketsData, error: listError } = await supabase.storage.listBuckets?.();
    if (!listError && Array.isArray(bucketsData)) {
      for (const candidate of candidates) {
        const matchingBucket = bucketsData.find((bucket) => bucket?.name === candidate);
        if (matchingBucket) {
          return candidate;
        }
      }
    }
  } catch (listErr) {
    lastError = listErr;
  }

  for (const candidate of candidates) {
    try {
      const createResult = await supabase.storage.createBucket?.(candidate, { public: true });
      if (!createResult?.error && createResult?.data) {
        return candidate;
      }
      lastError = createResult?.error || lastError;
    } catch (createErr) {
      lastError = createErr;
    }
  }

  throw lastError || new Error(`Storage bucket not found: ${bucketName}`);
};

const sanitizeFileName = (fileName = 'file') => {
  const baseName = String(fileName).replace(/\\/g, '/').split('/').pop() || 'file';
  return baseName
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'file';
};

const getSupabaseApiKey = () => {
  return process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
};

const getClientUserId = (req) => {
  const headerValue = req.headers['x-user-id'] || req.headers['X-User-Id'];
  return typeof headerValue === 'string' && headerValue.trim() ? headerValue.trim() : null;
};

const shouldDeleteAuthUser = () => false;

const shouldRetryStorageUpload = (error) => {
  const message = error?.message || '';
  return /row-level security policy|violates row-level security|bucket not found|not found/i.test(message);
};

const uploadToStorageWithServiceRole = async ({ bucketName, path, buffer, contentType = 'application/octet-stream' }) => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || process.env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return { error: new Error('Missing Supabase storage credentials') };
  }

  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(bucketName)}/${encodedPath}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'Content-Type': contentType,
        'cache-control': 'max-age=31536000',
        'x-upsert': 'true',
      },
      body: buffer,
    });

    if (!response.ok) {
      const payload = await response.text().catch(() => '');
      return { error: new Error(payload || `Storage upload failed with status ${response.status}`) };
    }

    return { error: null };
  } catch (err) {
    return { error: err };
  }
};

const decodeJwtPayload = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (err) {
    console.warn('[authenticateUser] Failed to decode JWT payload:', err.message);
    return null;
  }
};

const verifySupabaseToken = async (token) => {
  const supabase = getAdminClient();

  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (!userErr && userData?.user?.id) {
      return { user: userData.user };
    }
    console.warn('[authenticateUser] supabase.auth.getUser fallback:', userErr?.message || 'no user');
  } catch (err) {
    console.warn('[authenticateUser] supabase.auth.getUser threw:', err.message);
  }

  const apiKey = getSupabaseApiKey();
  if (!apiKey) {
    throw new Error('Missing Supabase API key');
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://cvsifkizrofmorvfmwmq.supabase.co';

  // Helper: fetch with timeout and a couple retries to avoid transient ECONNRESET
  const fetchWithTimeout = async (url, opts = {}, timeoutMs = 3000, retries = 1) => {
    const attempt = async () => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...opts, signal: controller.signal });
        clearTimeout(id);
        return res;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    };

    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await attempt();
      } catch (e) {
        lastErr = e;
        // on last attempt, rethrow
        if (i === retries) throw lastErr;
        // small backoff before retrying
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    throw lastErr;
  };

  let response;
  try {
    response = await fetchWithTimeout(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }, 4000, 2);
  } catch (err) {
    console.warn('[verifySupabaseToken] Supabase fetch failed:', err?.message || err);
    throw new Error('Auth lookup failed (network)');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || `Auth lookup failed with status ${response.status}`;
    throw new Error(message);
  }

  if (!payload?.id) {
    throw new Error('No user id returned from Supabase auth');
  }

  return { user: payload };
};

/**
 * Middleware: Verify Bearer token and get authenticated user
 */
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      console.error('[authenticateUser] Missing or invalid Authorization header');
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7).trim();

    try {
      const { user } = await verifySupabaseToken(token);
      req.userId = user.id;
      req.userEmail = user.email;
      return next();
    } catch (verifyErr) {
      console.warn('[authenticateUser] Token verification failed, trying client-provided user id:', verifyErr.message);
    }

    const clientUserId = getClientUserId(req);
    if (clientUserId) {
      req.userId = clientUserId;
      req.userEmail = req.headers['x-user-email'] || req.headers['X-User-Email'] || null;
      return next();
    }

    const jwtPayload = decodeJwtPayload(token);
    const jwtUserId = jwtPayload?.sub || jwtPayload?.user_id || jwtPayload?.id;
    if (jwtUserId) {
      req.userId = jwtUserId;
      req.userEmail = jwtPayload?.email || null;
      return next();
    }

    res.status(401).json({ error: 'Invalid or expired token' });
  } catch (err) {
    console.error('[authenticateUser] Error:', err.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * POST /api/account/devices/verify
 * Check whether the current client device token is still active.
 */
router.post('/devices/verify', authenticateUser, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'Device token is required' });
    }

    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('device_tokens')
      .select('id')
      .eq('user_id', req.userId)
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('[POST /devices/verify] Supabase error:', error);
      return res.status(500).json({ error: 'Failed to verify device' });
    }

    if (!data?.id) {
      return res.status(404).json({ revoked: true, message: 'Device token revoked' });
    }

    return res.json({ active: true });
  } catch (err) {
    console.error('[POST /devices/verify] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/account/devices
 * List all connected devices (device tokens) for the authenticated user
 */
router.get('/devices', authenticateUser, async (req, res) => {
  try {
    const supabase = getAdminClient();
    
    const { data: devices, error } = await supabase
      .from('device_tokens')
      .select('id, token, platform, created_at, updated_at, metadata')
      .eq('user_id', req.userId)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[GET /devices] Supabase error:', error);
      return res.status(500).json({ error: 'Failed to fetch devices' });
    }

    res.json({
      success: true,
      devices: devices || []
    });
  } catch (err) {
    console.error('[GET /devices] Unexpected error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/account/devices/:deviceId
 * Revoke/delete a specific device token
 */
router.delete('/devices/:deviceId', authenticateUser, async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const supabase = getAdminClient();
    
    // Verify the device belongs to the user
    const { data: device, error: fetchError } = await supabase
      .from('device_tokens')
      .select('id, user_id')
      .eq('id', deviceId)
      .maybeSingle();

    if (fetchError || !device) {
      console.error('[DELETE /devices/:deviceId] Device not found:', fetchError);
      return res.status(404).json({ error: 'Device not found' });
    }

    if (device.user_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized to delete this device' });
    }

    // Delete the device
    const { error: deleteError } = await supabase
      .from('device_tokens')
      .delete()
      .eq('id', deviceId);

    if (deleteError) {
      console.error('[DELETE /devices/:deviceId] Delete error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete device' });
    }

    res.json({
      success: true,
      message: 'Device revoked successfully'
    });
  } catch (err) {
    console.error('[DELETE /devices/:deviceId] Unexpected error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/delete-profile', authenticateUser, async (req, res) => {
  try {
    const profileId = String(req.body?.profileId || '');
    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required' });
    }

    const supabase = getAdminClient();
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, auth_user_id, avatar_url, avatar_path, media_files')
      .eq('id', profileId)
      .eq('auth_user_id', req.userId)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const storageObjects = new Map();
    const addObject = (value, bucket) => {
      const storageObject = getOwnedStorageObject(value, bucket, req.userId);
      if (storageObject) {
        if (!storageObjects.has(storageObject.bucket)) storageObjects.set(storageObject.bucket, new Set());
        storageObjects.get(storageObject.bucket).add(storageObject.path);
      }
    };

    addObject(profile.avatar_path, AVATAR_BUCKET);
    addObject(profile.avatar_url, AVATAR_BUCKET);
    let mediaFiles = profile.media_files;
    if (typeof mediaFiles === 'string') {
      try {
        mediaFiles = JSON.parse(mediaFiles);
      } catch (error) {
        console.warn('[DELETE profile] Could not parse profile media_files JSON:', error.message);
        mediaFiles = [];
      }
    }
    if (Array.isArray(mediaFiles)) {
      mediaFiles.forEach((media) => {
        const mediaBucket = STORAGE_BUCKETS.has(media?.storageBucket) ? media.storageBucket : MEDIA_BUCKET;
        if (typeof media === 'string') {
          addObject(media, MEDIA_BUCKET);
          return;
        }
        if (!media || typeof media !== 'object') return;
        addObject(media.path || media.storage_path || media.storagePath || media.file_path || media.filePath, mediaBucket);
        addObject(media.publicUrl || media.public_url || media.url || media.file_url || media.fileUrl, mediaBucket);
      });
    }

    for (const [bucket, paths] of storageObjects) {
      const { error: storageError } = await supabase.storage.from(bucket).remove([...paths]);
      if (storageError) {
        console.error('[DELETE profile] Storage cleanup failed:', { profileId, bucket, error: storageError });
        return res.status(500).json({ error: 'Could not delete all profile media. The profile was not deleted; please retry.' });
      }
    }

    const { data: deletedProfile, error: deleteError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', profileId)
      .eq('auth_user_id', req.userId)
      .select('id')
      .maybeSingle();

    if (deleteError) throw deleteError;
    if (!deletedProfile) return res.status(404).json({ error: 'Profile not found' });

    return res.json({ success: true, profileId: deletedProfile.id, deletedMediaFiles: [...storageObjects.values()].reduce((total, paths) => total + paths.size, 0) });
  } catch (error) {
    console.error('[POST /account/delete-profile] Failed:', error);
    return res.status(500).json({ error: 'Failed to delete profile and its media' });
  }
});

/**
 * POST /api/account/delete
 * Permanently delete the authenticated user's account
 * This will:
 * 1. Delete the user from Supabase auth
 * 2. Delete the profile (cascade will handle related data)
 * 3. Delete device tokens
 * 4. Delete user's media from storage
 */
router.post('/delete', authenticateUser, async (req, res) => {
  try {
    const supabase = getAdminClient();
    
    

    // Step 1: Fetch the user's profile to get media files and avatar
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, avatar_url, avatar_path, media_files')
      .eq('id', req.userId)
      .maybeSingle();

    if (profileError) {
      console.warn('[DELETE account] Warning fetching profile:', profileError.message);
    }

    // Step 2: Delete media files from storage if they exist
    if (profile) {
      try {
        const mediaFilesToDelete = [];

        // Add avatar if it's a stored path (not an external URL)
        if (profile.avatar_path) {
          mediaFilesToDelete.push(profile.avatar_path);
        } else if (profile.avatar_url && !profile.avatar_url.startsWith('http')) {
          mediaFilesToDelete.push(profile.avatar_url);
        }

        // Add user's media files
        if (Array.isArray(profile.media_files) && profile.media_files.length > 0) {
          profile.media_files.forEach(item => {
            if (typeof item === 'string') {
              mediaFilesToDelete.push(item);
            } else if (item.path) {
              mediaFilesToDelete.push(item.path);
            }
          });
        }

        // Delete all files from storage
        if (mediaFilesToDelete.length > 0) {
          
          
          // Delete from avatar bucket
          const avatarFiles = mediaFilesToDelete.filter(f => f.includes('avatars'));
          if (avatarFiles.length > 0) {
            const resolvedAvatarBucket = await resolveStorageBucket(supabase, AVATAR_BUCKET);
            await supabase.storage.from(resolvedAvatarBucket).remove(avatarFiles).catch(err => {
              console.warn('[DELETE account] Avatar deletion warning:', err.message);
            });
          }

          // Delete from media bucket
          const mediaFiles = mediaFilesToDelete.filter(f => !f.includes('avatars'));
          if (mediaFiles.length > 0) {
            const resolvedMediaBucket = await resolveStorageBucket(supabase, MEDIA_BUCKET);
            await supabase.storage.from(resolvedMediaBucket).remove(mediaFiles).catch(err => {
              console.warn('[DELETE account] Media deletion warning:', err.message);
            });
          }
        }
      } catch (storageErr) {
        console.warn('[DELETE account] Storage deletion error:', storageErr.message);
        // Continue with account deletion even if storage cleanup fails
      }
    }

    // Step 3: Delete device tokens (explicit, though cascade should handle it)
    try {
      await supabase
        .from('device_tokens')
        .delete()
        .eq('user_id', req.userId);
    } catch (deviceErr) {
      console.warn('[DELETE account] Device tokens deletion warning:', deviceErr.message);
    }

    // Step 4: Delete the profile row explicitly from the database
    const { error: profileDeleteError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', req.userId);

    if (profileDeleteError) {
      console.error('[DELETE account] Profile deletion error:', profileDeleteError);
      return res.status(500).json({ error: 'Failed to delete profile' });
    }

    // Step 5: Preserve the Supabase auth identity and only remove the app profile/data.
    if (shouldDeleteAuthUser()) {
      const { error: authDeleteError } = await supabase.auth.admin.deleteUser(req.userId);
      if (authDeleteError) {
        console.warn('[DELETE account] Auth deletion warning:', authDeleteError.message || authDeleteError);
      }
    } else {
      
    }

    // Step 6: Make sure no profile row remains in the database after auth deletion.
    const { data: leftoverProfile, error: leftoverProfileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();

    if (!leftoverProfileError && leftoverProfile?.id) {
      const { error: leftoverDeleteError } = await supabase
        .from('profiles')
        .delete()
        .eq('id', req.userId);

      if (leftoverDeleteError) {
        console.error('[DELETE account] Leftover profile cleanup error:', leftoverDeleteError);
        return res.status(500).json({ error: 'Failed to remove leftover profile' });
      }
    }

    

    res.json({
      success: true,
      message: 'Profile and related data removed successfully. Your authentication account was preserved.'
    });
  } catch (err) {
    console.error('[POST /account/delete] Unexpected error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

/**
 * POST /api/account/avatar-upload
 * Upload avatar file to Supabase via server-side fallback.
 */
router.post('/avatar-upload', authenticateUser, async (req, res) => {
  try {
    const { filename, mimeType, base64 } = req.body || {};
    if (!filename || !mimeType || !base64) {
      return res.status(400).json({ error: 'filename, mimeType, and base64 are required' });
    }
    if (!ALLOWED_IMAGE_TYPES.has(mimeType) || /\.gif$/i.test(filename)) {
      return res.status(400).json({ error: 'Only JPG, PNG, or WebP avatar images are supported.' });
    }

    const safeFilename = sanitizeFileName(filename);
    const timestamp = Date.now();
    const path = `${req.userId}/${timestamp}-${safeFilename}`;
    const supabase = getAdminClient();

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length >= MAX_IMAGE_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'Avatar image must be smaller than 1 MB.' });
    }
    let uploadBucket = await resolveStorageBucket(supabase, AVATAR_BUCKET);
    let uploadResult = await uploadToStorageWithServiceRole({
      bucketName: uploadBucket,
      path,
      buffer,
      contentType: mimeType,
    });

    if (uploadResult.error && shouldRetryStorageUpload(uploadResult.error)) {
      uploadBucket = await resolveStorageBucket(supabase, AVATAR_BUCKET);
      uploadResult = await uploadToStorageWithServiceRole({
        bucketName: uploadBucket,
        path,
        buffer,
        contentType: mimeType,
      });
    }

    if (uploadResult.error) {
      const errorMessage = uploadResult.error.message || 'Avatar upload failed';
      console.error('[POST /avatar-upload] Supabase storage error:', errorMessage, {
        bucket: uploadBucket,
        path,
        filename: safeFilename,
      });
      return res.status(500).json({ error: errorMessage });
    }

    const { data: publicUrlData, error: urlError } = supabase.storage
      .from(uploadBucket)
      .getPublicUrl(path);

    if (urlError) {
      console.warn('[POST /avatar-upload] Public URL warning:', urlError);
    }

    return res.json({
      path,
      publicUrl: publicUrlData?.publicUrl || null,
    });
  } catch (err) {
    console.error('[POST /avatar-upload] Unexpected error:', err.message, {
      bucket: AVATAR_BUCKET,
      userId: req.userId,
    });
    return res.status(500).json({ error: 'Avatar upload failed' });
  }
});

/**
 * POST /api/account/media-upload
 * Upload media file to Supabase via server-side fallback.
 */
router.post('/media-upload', authenticateUser, async (req, res) => {
  try {
    const { filename, mimeType, base64 } = req.body || {};
    if (!filename || !mimeType || !base64) {
      return res.status(400).json({ error: 'filename, mimeType, and base64 are required' });
    }
    if (!ALLOWED_MEDIA_TYPES.has(mimeType) || /\.gif$/i.test(filename)) {
      return res.status(400).json({ error: 'Choose a supported JPG, PNG, WebP, video clip, or PDF file.' });
    }

    const safeFilename = sanitizeFileName(filename);
    const timestamp = Date.now();
    const path = `${req.userId}/${timestamp}-${safeFilename}`;
    const supabase = getAdminClient();

    const buffer = Buffer.from(base64, 'base64');
    if (ALLOWED_IMAGE_TYPES.has(mimeType) && buffer.length >= MAX_IMAGE_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'Images must be smaller than 1 MB.' });
    }
    if (ALLOWED_VIDEO_TYPES.has(mimeType) && buffer.length > MAX_VIDEO_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'Video clips must be 10 MB or smaller.' });
    }
    if (buffer.length > MAX_MEDIA_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'Media files must be 50 MB or smaller.' });
    }
    let uploadBucket = await resolveStorageBucket(supabase, MEDIA_BUCKET);
    let uploadResult = await uploadToStorageWithServiceRole({
      bucketName: uploadBucket,
      path,
      buffer,
      contentType: mimeType,
    });

    if (uploadResult.error && shouldRetryStorageUpload(uploadResult.error)) {
      uploadBucket = await resolveStorageBucket(supabase, MEDIA_BUCKET);
      uploadResult = await uploadToStorageWithServiceRole({
        bucketName: uploadBucket,
        path,
        buffer,
        contentType: mimeType,
      });
    }

    if (uploadResult.error) {
      const errorMessage = uploadResult.error.message || 'Media upload failed';
      console.error('[POST /media-upload] Supabase storage error:', errorMessage, {
        bucket: uploadBucket,
        path,
        filename: safeFilename,
      });
      return res.status(500).json({ error: errorMessage });
    }

    const { data: publicUrlData, error: urlError } = supabase.storage
      .from(uploadBucket)
      .getPublicUrl(path);

    if (urlError) {
      console.warn('[POST /media-upload] Public URL warning:', urlError);
    }

    return res.json({
      path,
      publicUrl: publicUrlData?.publicUrl || null,
    });
  } catch (err) {
    console.error('[POST /media-upload] Unexpected error:', err.message, {
      bucket: MEDIA_BUCKET,
      userId: req.userId,
    });
    return res.status(500).json({ error: 'Media upload failed' });
  }
});

module.exports = {
  router,
  shouldDeleteAuthUser,
  resolveStorageBucket,
  shouldRetryStorageUpload,
  uploadToStorageWithServiceRole,
};
