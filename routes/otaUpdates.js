const axios = require('axios');
const express = require('express');
const { getGitHubApiHeaders } = require('../services/githubApi');

const router = express.Router();
const GITHUB_RELEASE_URL = 'https://api.github.com/repos/somalux254-ux/Somalux2.0Frontend/releases/tags/Joblink';
const BUNDLE_ASSET_PATTERN = /^joblink-ota-(\d{13})\.zip$/;
const CACHE_DURATION_MS = 5 * 60 * 1000;

let cachedUpdate = null;
let cacheExpiresAt = 0;

router.get('/latest', async (req, res) => {
  if (Date.now() < cacheExpiresAt) {
    return res.json({ update: cachedUpdate });
  }

  try {
    const response = await axios.get(GITHUB_RELEASE_URL, {
      headers: getGitHubApiHeaders(),
      timeout: 10000,
    });
    const latestAsset = (response.data.assets || [])
      .map((asset) => ({ asset, match: asset.name.match(BUNDLE_ASSET_PATTERN) }))
      .filter(({ asset, match }) => match && /^https:\/\/github\.com\/somalux254-ux\/Somalux2\.0Frontend\/releases\/download\/Joblink\//.test(asset.browser_download_url))
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0];

    const checksum = latestAsset?.asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1].toLowerCase();
    if (latestAsset && !checksum) {
      throw new Error(`GitHub did not provide a valid SHA-256 digest for ${latestAsset.asset.name}.`);
    }

    cachedUpdate = latestAsset
      ? {
        version: latestAsset.match[1],
        downloadUrl: latestAsset.asset.browser_download_url,
        checksum,
      }
      : null;
    cacheExpiresAt = Date.now() + CACHE_DURATION_MS;
    return res.json({ update: cachedUpdate });
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    console.error(
      `[ota-updates] Failed to fetch the latest GitHub bundle${status ? ` (HTTP ${status})` : ''}:`,
      message
    );
    if (cachedUpdate) {
      console.warn(`[ota-updates] Serving cached OTA bundle ${cachedUpdate.version} after the GitHub lookup failed.`);
      cacheExpiresAt = Date.now() + CACHE_DURATION_MS;
      return res.json({ update: cachedUpdate });
    }
    return res.status(502).json({ error: 'Could not check for OTA updates.' });
  }
});

module.exports = router;
