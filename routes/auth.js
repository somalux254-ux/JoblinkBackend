const express = require('express');
const router = express.Router();
const { verifyGoogleEmail, sendVerificationCode, verifyCode } = require('../config/emailVerification');
const { getAdminClient } = require('../supabaseAdmin');
const { emailBody, codeBody, googleSigninBody } = require('../middleware/validators');
const { OAuth2Client } = require('google-auth-library');
const { buildGoogleAudienceList, decodeJwtPayload, isAudienceAllowed } = require('../config/googleClients');

const normalizeEmail = (email) => String(email || '').toLowerCase().trim();

/**
 * POST /api/auth/verify-google-email
 * Check if email format is valid and if already verified
 */
router.post('/verify-google-email', emailBody, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required',
        valid: false,
        exists: false,
        alreadyRegistered: false,
        verified: false
      });
    }

    const normalizedEmail = String(email).toLowerCase();

    if (!normalizedEmail.endsWith('@gmail.com')) {
      return res.json({
        valid: false,
        exists: false,
        alreadyRegistered: false,
        verified: false,
        email,
        message: 'Only Gmail addresses are allowed'
      });
    }

    const result = await verifyGoogleEmail(email);
    return res.json({
      ...result,
      valid: result.exists === true,
      exists: result.exists === true,
      alreadyRegistered: false
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({
      error: 'Email verification failed',
      valid: false,
      exists: false,
      alreadyRegistered: false,
      verified: false,
      message: error.message
    });
  }
});

/**
 * POST /api/auth/send-verification-code
 * Send a verification code to the user's email
 * 
 * Request body:
 * {
 *   email: "user@gmail.com"
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   message: string,
 *   expiresIn: string
 * }
 */
router.post('/send-verification-code', emailBody, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const normalizedEmail = String(email).toLowerCase();
    const result = await sendVerificationCode(email);
    return res.json(result);

  } catch (error) {
    console.error('Send verification code error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send verification code'
    });
  }
});

/**
 * POST /api/auth/verify-code
 * Verify the code entered by user
 * 
 * Request body:
 * {
 *   email: "user@gmail.com",
 *   code: "123456"
 * }
 * 
 * Response:
 * {
 *   verified: boolean,
 *   message: string
 * }
 */
router.post('/verify-code', codeBody, async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        verified: false,
        message: 'Email and code are required'
      });
    }

    const result = await verifyCode(email, code);
    
    // Use 400 for verification failures, 200 for success
    const statusCode = result.verified ? 200 : 400;
    return res.status(statusCode).json(result);

  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({
      verified: false,
      message: 'Verification failed'
    });
  }
});

/**
 * POST /api/auth/google-signin
 * Handle Google One Tap sign-in
 * Verifies Google token and creates Supabase session
 */
router.post('/google-signin', googleSigninBody, async (req, res) => {
  try {
    const { token, email, name } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Google token is required',
        message: 'Missing token'
      });
    }

    

    const looksLikeJwt = (value) => typeof value === 'string' && value.split('.').length === 3 && value.length > 20;
    if (!looksLikeJwt(token)) {
      console.warn('⚠️ Refused invalid Google token format:', typeof token === 'string' ? token : 'non-string');
      return res.status(400).json({
        error: 'Invalid Google token format',
        message: 'Google ID token must be a JWT token from Google.'
      });
    }

    // Verify Google token against the web and Android OAuth client IDs used by the app.
    const googleClientIds = buildGoogleAudienceList(process.env);
    const googleClient = new OAuth2Client(googleClientIds[0]);

    // Decode token payload to log the audience (helps debug audience mismatches)
    let decodedPayload = null;
    let decodedAud = null;
    try {
      decodedPayload = decodeJwtPayload(token);
      decodedAud = decodedPayload?.aud || decodedPayload?.audience || null;
      
    } catch (e) {
      console.warn('⚠️ Failed to decode token payload for debugging:', e.message);
    }

    let payload;
    let isGooglePayloadVerified = false;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: googleClientIds,
      });
      payload = ticket.getPayload();
      isGooglePayloadVerified = true;
      
    } catch (tokenError) {
      const message = tokenError?.message || String(tokenError);
      console.error('❌ Google token verification failed:', message);
      console.error('   Expected audiences:', googleClientIds);
      console.error('   Decoded token aud (pre-verify):', decodedAud);

      if (decodedPayload?.email && decodedPayload?.sub) {
        const isAllowedAudience = isAudienceAllowed(decodedAud, googleClientIds);
        

        payload = {
          email: decodedPayload.email,
          sub: decodedPayload.sub,
          aud: decodedAud,
          name: decodedPayload.name || decodedPayload.given_name || decodedPayload.family_name || null,
          given_name: decodedPayload.given_name || null,
          family_name: decodedPayload.family_name || null,
          picture: decodedPayload.picture || null,
        };
      } else {
        return res.status(401).json({
          error: 'Invalid Google token',
          message: 'Token verification failed',
          token_audience: decodedAud || undefined,
          expected_audiences: googleClientIds
        });
      }
    }

    // Initialize Supabase admin client
    let supabase;
    try {
      supabase = getAdminClient();
    } catch (e) {
      console.error('⚠️ SUPABASE_SERVICE_ROLE_KEY not set in environment', e?.message || e);
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Missing Supabase service role key'
      });
    }

    // Establish the auth session first. The client routes to profile/onboarding
    // immediately afterward and performs exactly one profile check there.
    const { data: signInData, error: signInError } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token,
    });

    if (signInError) {
      console.error('❌ Session generation error:', signInError);
      return res.status(500).json({
        error: 'Session creation failed',
        message: signInError.message
      });
    }

    if (!signInData?.session || !signInData?.user) {
      console.error('❌ Invalid session response from Supabase:', signInData);
      return res.status(500).json({
        error: 'Session creation failed',
        message: 'Invalid session response from Supabase'
      });
    }

    if (isGooglePayloadVerified && payload.picture) {
      const existingMetadata = signInData.user.user_metadata || {};
      const googleMetadata = {
        ...existingMetadata,
        picture: payload.picture,
        avatar_url: payload.picture,
        ...(payload.name ? { full_name: payload.name, name: payload.name } : {}),
        ...(payload.given_name ? { given_name: payload.given_name } : {}),
        ...(payload.family_name ? { family_name: payload.family_name } : {}),
      };
      const { error: metadataError } = await supabase.auth.admin.updateUserById(signInData.user.id, {
        user_metadata: googleMetadata,
      });
      if (metadataError) {
        console.error('[google-signin] Could not save verified Google profile photo to Auth metadata:', metadataError);
      }
    }

    
    
    

    

    res.json({
      user: {
        id: signInData.user.id,
        email: signInData.user.email,
        user_metadata: signInData.user.user_metadata,
      },
      session: {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
        token_type: signInData.session.token_type,
        expires_in: signInData.session.expires_in,
      },
      message: 'User signed in successfully'
    });

  } catch (error) {
    console.error('❌ Google sign-in error:', error);
    res.status(500).json({
      error: 'Google sign-in failed',
      message: error.message
    });
  }
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({ status: 'Auth service is running' });
});

/**
 * GET /api/auth/avatar-proxy
 * Proxy an external avatar URL so mobile WebViews can load images that
 * may otherwise be blocked or redirected. This endpoint restricts hosts
 * to a safe allowlist to reduce SSRF risk.
 * Query params: url (required)
 */
router.get('/avatar-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    // Only allow common avatar hosts (extend as necessary)
    const allowedHosts = [
      'googleusercontent.com',
      'gstatic.com',
      'gravatar.com',
      'cloudflareusercontent.com'
    ];

    const hostAllowed = allowedHosts.some(h => parsed.hostname.endsWith(h));
    if (!hostAllowed) return res.status(400).json({ error: 'Host not allowed' });

    // Fetch image
    const axios = require('axios');
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    const contentType = response.headers['content-type'] || 'image/jpeg';

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(response.data);
  } catch (error) {
    console.error('Avatar proxy error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to proxy avatar' });
  }
});

module.exports = router;
