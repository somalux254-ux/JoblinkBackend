const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

const FIREBASE_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FIREBASE_MESSAGING_ENDPOINT = (projectId) =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

function loadFirebaseCredentials() {
  const serializedCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serializedCredentials) return null;

  const credentials = JSON.parse(serializedCredentials);
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
  return credentials;
}

function asString(value) {
  return value === undefined || value === null ? '' : String(value);
}

function buildFcmData(record, badgeCount = 1) {
  const payload = record.data && typeof record.data === 'object' ? record.data : {};
  const likeRow = payload.like_row && typeof payload.like_row === 'object' ? payload.like_row : {};
  const type = asString(record.type);
  const actorId = asString(record.actor_id || payload.actor_id || likeRow.liker_id || '');
  const messageId = asString(payload.message_id || '');
  const clickAction = type === 'message' && actorId && messageId
    ? `joblink://message?senderId=${encodeURIComponent(actorId)}&messageId=${encodeURIComponent(messageId)}`
    : asString(payload.click_action || 'joblink://app/notifications');

  return {
    title: asString(record.title || 'New notification'),
    body: asString(record.body || 'You have a new update'),
    badge: asString(badgeCount),
    notification_id: asString(record.id),
    type,
    actor_id: actorId,
    message_id: messageId,
    actor_name: asString(payload.actor_name || payload.actor || 'Someone'),
    actor_avatar: asString(payload.actor_avatar || payload.actor_image || payload.avatar_url || ''),
    target_id: asString(payload.target_id || payload.target_profile || payload.liked_profile_id || likeRow.liked_profile_id || ''),
    conversation_id: asString(payload.conversation_id || payload.thread_id || record.actor_id || record.id),
    click_action: clickAction,
  };
}

function buildFcmMessage(token, data) {
  return {
    token,
    data,
    notification: {
      title: data.title,
      body: data.body,
    },
    android: {
      priority: 'HIGH',
      notification: {
        channel_id: 'joblink_notifications_v3',
        sound: 'default',
      },
    },
  };
}

function startFcmNotificationListener(supabase, onStatusChange = () => {}) {
  let credentials;
  try {
    credentials = loadFirebaseCredentials();
  } catch (error) {
    console.error('[FCM] FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON:', error.message);
    onStatusChange('invalid_credentials');
    return null;
  }

  if (!credentials?.project_id || !credentials?.client_email || !credentials?.private_key) {
    console.warn('[FCM] Push delivery disabled: FIREBASE_SERVICE_ACCOUNT_JSON is not configured.');
    onStatusChange('missing_credentials');
    return null;
  }

  const auth = new GoogleAuth({ credentials, scopes: [FIREBASE_MESSAGING_SCOPE] });
  const channel = supabase
    .channel('server-notification-fcm')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
    }, async ({ new: notification }) => {
      if (!notification?.user_id) return;

      try {
        const { data: recipientProfile, error: profileError } = await supabase
          .from('profiles')
          .select('auth_user_id')
          .eq('id', notification.user_id)
          .maybeSingle();

        if (profileError) throw profileError;
        if (!recipientProfile?.auth_user_id) {
          console.warn(`[FCM] Notification recipient profile ${notification.user_id} has no linked auth user.`);
          return;
        }

        const { data: devices, error } = await supabase
          .from('device_tokens')
          .select('token')
          .eq('user_id', recipientProfile.auth_user_id)
          .eq('platform', 'android');

        if (error) throw error;
        if (!devices?.length) {
          
          return;
        }

        const { count: unreadCount, error: unreadCountError } = await supabase
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', notification.user_id)
          .eq('read', false);
        if (unreadCountError) throw unreadCountError;

        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();
        const data = buildFcmData(notification, unreadCount || 1);
        const results = await Promise.allSettled(devices.map(({ token }) => axios.post(
          FIREBASE_MESSAGING_ENDPOINT(credentials.project_id),
          {
            message: buildFcmMessage(token, data),
          },
          { headers: { Authorization: `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' } }
        )));

        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) {
          failures.forEach(({ reason }) => {
            console.error('[FCM] Could not deliver Android notification:', reason?.response?.data || reason?.message || reason);
          });
        } else {
          
        }
      } catch (error) {
        console.error('[FCM] Notification delivery failed:', error?.response?.data || error.message || error);
      }
    })
    .subscribe((status, error) => {
      if (status === 'SUBSCRIBED') {
        
        onStatusChange('subscribed');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error(`[FCM] Notification subscription ${status}:`, error || '');
        onStatusChange(status.toLowerCase());
      } else if (status === 'CLOSED') {
        console.warn('[FCM] Notification subscription closed.');
        onStatusChange('closed');
      }
    });

  return channel;
}

module.exports = { buildFcmData, buildFcmMessage, startFcmNotificationListener };