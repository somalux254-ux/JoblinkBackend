const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFcmData, buildFcmMessage } = require('./fcmNotifications');

test('buildFcmData includes the current unread count in the push data payload', () => {
  const data = buildFcmData({
      id: 'notification-123',
      title: 'New follower',
      body: 'Alex followed you',
      type: 'follow',
      actor_id: 'actor-456',
      data: { actor_name: 'Alex' },
    }, 4);

  assert.equal(data.title, 'New follower');
  assert.equal(data.body, 'Alex followed you');
  assert.equal(data.badge, '4');
  assert.equal(data.notification_id, 'notification-123');
  assert.equal(data.type, 'follow');
});

test('buildFcmData sends message notifications to the native chat deep link', () => {
  const data = buildFcmData({
    id: 'notification-123',
    title: 'New message',
    body: 'Hello',
    type: 'message',
    actor_id: 'sender-456',
    data: {
      message_id: 'message-789',
      click_action: 'joblink://app/notifications',
    },
  });

  assert.equal(data.message_id, 'message-789');
  assert.equal(data.click_action, 'joblink://message?senderId=sender-456&messageId=message-789');
});

test('buildFcmMessage includes an Android system notification for background delivery', () => {
  const data = buildFcmData({
    id: 'notification-123',
    title: 'New message',
    body: 'Hello',
    type: 'message',
    actor_id: 'sender-456',
  });
  const message = buildFcmMessage('device-token', data);

  assert.equal(message.token, 'device-token');
  assert.deepEqual(message.notification, { title: 'New message', body: 'Hello' });
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.notification.channel_id, 'joblink_notifications_v3');
  assert.equal(message.data.click_action, 'joblink://app/notifications');
});
