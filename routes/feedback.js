const express = require('express');
const router = express.Router();

/**
 * POST /api/feedback
 * Accepts user feedback from the app and logs it for admin review.
 */
router.post('/', async (req, res) => {
  try {
    const { message, page, email } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Feedback message is required.' });
    }

    const feedbackEntry = {
      message: message.trim(),
      page: page || null,
      email: email || null,
      submittedAt: new Date().toISOString()
    };

    console.log('📩 New feedback submitted:', JSON.stringify(feedbackEntry, null, 2));

    return res.json({ ok: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    console.error('Feedback submission error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to submit feedback.' });
  }
});

module.exports = router;
