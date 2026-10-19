const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFcmData } = require('./fcmNotifications');

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
