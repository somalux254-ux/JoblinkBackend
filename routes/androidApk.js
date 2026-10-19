const express = require('express');
const axios = require('axios');

const router = express.Router();
const APK_URL = 'https://github.com/somalux254-ux/Somalux2.0Frontend/releases/download/Somalux/Somalux.apk';
const LATEST_RELEASE_URL = 'https://api.github.com/repos/somalux254-ux/Somalux2.0Frontend/releases/latest';

const compareVersions = (currentVersion, latestVersion) => {
  const current = String(currentVersion || '0').replace(/^v/i, '').split('.').map(Number);
  const latest = String(latestVersion || '0').replace(/^v/i, '').split('.').map(Number);
  const length = Math.max(current.length, latest.length);

  for (let index = 0; index < length; index += 1) {
    const currentPart = Number.isFinite(current[index]) ? current[index] : 0;
    const latestPart = Number.isFinite(latest[index]) ? latest[index] : 0;
    if (latestPart !== currentPart) return latestPart > currentPart;
  }

  return false;
};

router.get('/status', async (req, res) => {
  try {
    const response = await axios.get(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    const latestVersion = response.data.tag_name || response.data.name || '0';
    return res.json({
      latestVersion,
      updateAvailable: compareVersions(req.query.currentVersion, latestVersion)
    });
  } catch (error) {
    console.warn('[apk-status] Failed to check Somalux release:', error.message);
    return res.json({ updateAvailable: false });
  }
});

router.get('/download', (req, res) => {
  res.redirect(302, APK_URL);
});

module.exports = router;
