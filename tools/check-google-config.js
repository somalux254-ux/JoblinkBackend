const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
const googleServicesPath = path.join(androidDir, 'app', 'google-services.json');

function runGradleSigningReport() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const gradleCmd = isWin ? '.\\gradlew.bat signingReport' : './gradlew signingReport';
    exec(gradleCmd, { cwd: androidDir, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.toString());
    });
  });
}

function parseShaFromGradle(output) {
  // Match lines like "SHA1: AA:BB:CC..." or "SHA-1: AA:BB:..." or "SHA1: AABBCC..."
  const re = /SHA-?1[:\s]+([0-9A-Fa-f:]+)/g;
  const matches = [];
  let m;
  while ((m = re.exec(output)) !== null) {
    matches.push(m[1]);
  }
  return matches.length ? matches[0] : null;
}

function normalizeHex(s) {
  if (!s) return null;
  return s.replace(/[:\s]/g, '').toLowerCase();
}

async function main() {
  console.log('Checking Android signing SHA-1 against android/app/google-services.json...');

  if (!fs.existsSync(googleServicesPath)) {
    console.error('google-services.json not found at', googleServicesPath);
    process.exit(2);
  }

  const gsRaw = fs.readFileSync(googleServicesPath, 'utf8');
  const gs = JSON.parse(gsRaw);
  // Find first android oauth client with certificate_hash
  let certHash = null;
  try {
    const clients = gs.client || [];
    for (const c of clients) {
      const oauth = c.oauth_client || [];
      for (const oc of oauth) {
        if (oc.client_type === 1 && oc.android_info && oc.android_info.certificate_hash) {
          certHash = oc.android_info.certificate_hash;
          break;
        }
      }
      if (certHash) break;
    }
  } catch (e) {
    // ignore
  }

  if (!certHash) {
    console.warn('No certificate_hash found in google-services.json to compare against. Will scan file for any matching fingerprint.');
  }

  let gradleOut = null;
  try {
    gradleOut = await runGradleSigningReport();
  } catch (e) {
    console.error('Failed to run gradle signingReport:', e.message);
    console.error('You can run it manually: cd android && gradlew signingReport');
    process.exit(2);
  }

  const foundSha = parseShaFromGradle(gradleOut);
  if (!foundSha) {
    console.error('Could not find SHA-1 in gradle output. Run `cd android && gradlew signingReport` and inspect output.');
    process.exit(2);
  }

  const normalizedGradle = normalizeHex(foundSha);
  const normalizedCert = normalizeHex(certHash);

  console.log('Detected local SHA-1:', foundSha);
  console.log('google-services.json certificate_hash:', certHash);

  // Also check raw file content for either colon-separated or normalized hex fingerprint
  const colonForm = normalizedGradle.match(/.{2}/g).join(':').toUpperCase();
  const gsRawLower = gsRaw.toLowerCase();
  const hasInRawColon = gsRawLower.indexOf(colonForm.toLowerCase()) !== -1;
  const hasInRawHex = gsRawLower.indexOf(normalizedGradle) !== -1;

  if (normalizedCert && normalizedGradle === normalizedCert) {
    console.log('\u2714 SHA-1 matches google-services.json certificate_hash. Native Google Sign-In should be correctly configured for this keystore.');
    process.exit(0);
  }

  if (hasInRawColon || hasInRawHex) {
    console.log('\u2714 Found local SHA-1 in google-services.json content (raw). Native Google Sign-In should be accepted.');
    console.log('Found as colon-form:', hasInRawColon, 'or hex-form:', hasInRawHex);
    process.exit(0);
  }

  console.error('\u2716 SHA-1 mismatch. Native Google Sign-In will fail with DEVELOPER_ERROR (10).');
  console.error('Steps to fix:');
  console.error('- In Google Cloud Console / Firebase, add the SHA-1 fingerprint below to the Android OAuth client for package `com.joblink.app` or create a new Android OAuth client with that SHA-1.');
  console.error('- Re-download updated google-services.json and replace android/app/google-services.json.');
  console.error('- Rebuild the Android app and reinstall.');
  console.error('\nLocal SHA-1 (to add):', foundSha);
  console.error('Current google-services.json SHA-1:', certHash);
  process.exit(3);
}

main().catch((e) => {
  console.error('Unexpected error:', e.message || e);
  process.exit(2);
});
