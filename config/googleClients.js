const DEFAULT_WEB_CLIENT_ID = '1053677464000-2sbmgpffk5qjtmpmtkj093uhkvrfnbsn.apps.googleusercontent.com';
const DEFAULT_ANDROID_CLIENT_ID = '541772603049-ojeo9ea35qjdr8vg3tjolslkar4m7h6r.apps.googleusercontent.com';
const DEFAULT_RELEASE_ANDROID_CLIENT_ID = '1053677464000-77e3jou8dc9sj8shav2hsp0ik4okj1ih.apps.googleusercontent.com';

function buildGoogleAudienceList(env = process.env) {
  const audiences = [];

  const addAudience = (value) => {
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim();
      if (!audiences.includes(normalized)) {
        audiences.push(normalized);
      }
    }
  };

  addAudience(env.GOOGLE_CLIENT_ID);
  addAudience(env.GOOGLE_ANDROID_CLIENT_ID);
  addAudience(env.GOOGLE_ANDROID_RELEASE_CLIENT_ID);
  addAudience(process.env.GOOGLE_ANDROID_CLIENT_ID);
  addAudience(process.env.GOOGLE_ANDROID_RELEASE_CLIENT_ID);
  addAudience(DEFAULT_WEB_CLIENT_ID);
  addAudience(DEFAULT_ANDROID_CLIENT_ID);
  addAudience(DEFAULT_RELEASE_ANDROID_CLIENT_ID);

  return audiences;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function isAudienceAllowed(audience, allowedAudiences = []) {
  if (!audience || !Array.isArray(allowedAudiences) || allowedAudiences.length === 0) {
    return false;
  }

  return allowedAudiences.some((allowedAudience) => String(allowedAudience).trim() === String(audience).trim());
}

module.exports = {
  buildGoogleAudienceList,
  decodeJwtPayload,
  isAudienceAllowed,
  DEFAULT_WEB_CLIENT_ID,
  DEFAULT_ANDROID_CLIENT_ID,
  DEFAULT_RELEASE_ANDROID_CLIENT_ID,
};
