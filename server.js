const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// Load backend-specific .env first, then root .env as fallback.
const backendEnvPath = path.resolve(__dirname, '.env');
const rootEnvPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: backendEnvPath });
dotenv.config({ path: rootEnvPath, override: false });
console.log(`✅ Loaded env files: ${backendEnvPath}${process.env.PORT ? '' : ` (root fallback ${rootEnvPath} may be used)`}`);

// Import routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const { router: accountRoutes } = require('./routes/account');
const feedbackRoutes = require('./routes/feedback');
const utilsRoutes = require('./routes/utils');
const androidApkRoutes = require('./routes/androidApk');
const otaUpdateRoutes = require('./routes/otaUpdates');
// Debug routes for auth inspection (only enabled on server side)
let debugAuthRoutes;
try {
  debugAuthRoutes = require('./routes/debug-auth');
} catch (e) {
  debugAuthRoutes = null;
}
const { authLimiter } = require('./middleware/rateLimiter');
const { metricsMiddleware, register } = require('./metrics');
const { getAdminClient } = require('./supabaseAdmin');
const { startFcmNotificationListener } = require('./services/fcmNotifications');

const supabaseEnvStatus = {
  SUPABASE_URL: Boolean(process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE),
};
console.log('ℹ️ Supabase environment variables loaded:', supabaseEnvStatus);

const app = express();

// Middleware
app.set('trust proxy', 1);
app.use(cors());
// Allow larger JSON payloads for base64 file uploads (avatar/media uploads)
app.use(express.json({ limit: '100mb' }));
app.use(metricsMiddleware);
const slowLogger = require('./middleware/slowLogger');
app.use(slowLogger(200));

// Routes
// Apply conservative rate limits to auth endpoints to reduce abusive traffic
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/utils', utilsRoutes);
app.use('/api/android/apk', androidApkRoutes);
app.use('/api/ota', otaUpdateRoutes);
if (debugAuthRoutes) app.use('/api/debug-auth', debugAuthRoutes);

// Server-side realtime listener: invalidate cache when follows change
const hasSupabaseAdmin = Boolean(process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE);
let fcmNotificationStatus = 'disabled';

if (!hasSupabaseAdmin) {
  console.warn('⚠️ Realtime listener disabled: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
} else {
  try {
    const supabase = getAdminClient();
    if (supabase && typeof supabase.channel === 'function') {
      fcmNotificationStatus = 'connecting';
      const fcmChannel = startFcmNotificationListener(supabase, (status) => {
        fcmNotificationStatus = status;
      });
      if (!fcmChannel && fcmNotificationStatus === 'connecting') {
        fcmNotificationStatus = 'disabled';
      }
      const channel = supabase.channel('server-follows-listener');
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'follows' }, (payload) => {
        try {
          const followedId = payload?.new?.followed_id || payload?.old?.followed_id;
          if (followedId) {
            // Cache invalidation is disabled because Redis has been removed.
          }
        } catch (e) {
          console.warn('[realtime] follow event handling error', e?.message || e);
        }
      });
      try {
        channel.subscribe();
        console.log('✅ Subscribed to follows realtime events');
      } catch (e) {
        console.warn('⚠️ Realtime subscribe failed', e?.message || e);
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to initialize realtime follow listener', e?.message || e);
  }
}

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'Backend server is running',
    pushNotificationsEnabled: fcmNotificationStatus === 'subscribed',
    pushNotificationStatus: fcmNotificationStatus,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    console.warn('PayloadTooLargeError:', err.message);
    return res.status(413).json({
      error: 'Payload too large',
      message: err.message
    });
  }

  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// Start server
const PORT = process.env.BACKEND_PORT || process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Joblink Backend running on port ${PORT}`);
  console.log(`📧 Email verification endpoint: POST /api/auth/verify-google-email`);
  console.log(`🔒 Admin endpoints mounted at: /api/admin`);
});

module.exports = app;
