const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');
const fs = require('fs');
const path = require('path');

const isValidSendGridApiKey = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('PLACEHOLDER') || normalized.startsWith('<') || normalized.endsWith('>')) {
    return false;
  }

  return /^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized);
};

const requestedEmailVerificationMethod = (process.env.EMAIL_VERIFICATION_METHOD || '').toLowerCase();
const hasSendGridKey = isValidSendGridApiKey(process.env.SENDGRID_API_KEY);
const isSendGridConfigured = hasSendGridKey;
const isGmailConfigured = Boolean(process.env.GMAIL_SEND_EMAIL && process.env.GMAIL_SEND_PASSWORD);

let EMAIL_VERIFICATION_METHOD = requestedEmailVerificationMethod;
if (!EMAIL_VERIFICATION_METHOD) {
  EMAIL_VERIFICATION_METHOD = isSendGridConfigured ? 'sendgrid' : 'smtp';
}

if (requestedEmailVerificationMethod === 'sendgrid' && !isSendGridConfigured && isGmailConfigured) {
  console.warn('⚠️ SendGrid requested but SENDGRID_API_KEY is missing or invalid; falling back to SMTP because Gmail credentials are configured.');
  EMAIL_VERIFICATION_METHOD = 'smtp';
}

/**
 * Get base64 encoded logo
 */
const getLogoBase64 = () => {
  try {
    const logoPath = path.join(__dirname, '../', 'LinkWhite.png');
    
    if (fs.existsSync(logoPath)) {
      const logoData = fs.readFileSync(logoPath);
      const base64 = logoData.toString('base64');
      
      return 'data:image/png;base64,' + base64;
    } else {
      console.warn(`⚠️ Logo file not found at: ${logoPath}`);
    }
  } catch (err) {
    console.error('❌ Error loading logo:', err.message);
  }
  return null;
};

/**
 * Pending verifications storage - tracks codes sent to emails
 * Format: { email: { code: '123456', expiresAt: timestamp, attempts: 0 } }
 */
const pendingVerifications = new Map();
const MAX_VERIFICATION_ATTEMPTS = 5;
const CODE_EXPIRY_TIME = 15 * 60 * 1000; // 15 minutes
const VERIFICATION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Verified emails cache - emails that have been verified via OTP
 */
const verifiedEmails = new Map();

/**
 * Generate a random 6-digit verification code
 */
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const getEmailTemplate = (code, userEmail) => {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Verify Your Email</title>
<style>
* { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background-color: #ffffff; }
body { background-color: #ffffff; width: 100% !important; min-width: 100% !important; }
table { width: 100% !important; max-width: 100%; border-spacing: 0; border-collapse: collapse; }
td, th { padding: 0; margin: 0; word-break: break-word; }
img { outline: none; border: none; text-decoration: none; }
a { text-decoration: none; color: inherit; }
</style>
</head>
<body>
<table role="presentation" width="100%">
<tbody>
<tr>
<td style="padding: 0; width: 100%;">
<div style="background-color: #ffffff; padding: 20px 8px; margin: 8px; border-radius: 12px;">
<h1 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 700; color: #000000;">Joblink</h1>
<div style="border: 1px solid #f0f0f0; border-radius: 8px; padding: 16px 20px; margin: 0 0 20px 0;">
<p style="margin: 0 0 12px 0; font-size: 14px; color: #555555;">Hello, Welcome to Joblink. Your verification code is:</p>
<div style="text-align: center; margin: 12px 0;">
<p style="margin: 0; font-size: 28px; font-weight: 500; color: #cccccc; letter-spacing: 12px; font-family: monospace;">${code}</p>
</div>
<p style="margin: 12px 0 8px 0; font-size: 12px; color: #555555;">This code is valid for <span style="color: #ffffff;">15 minutes</span> and can only be used once.</p>
<p style="margin: 0; font-size: 12px; color: #ffffff;">Please don't share this code with anyone.</p>
<p style="margin: 12px 0 0 0; font-size: 12px; color: #555555;">You are receiving this email because a verification code was requested for you to be able to create Joblink account. If you did not request this, ignore this email.</p>
<p style="margin: 12px 0 0 0; font-size: 12px; color: #555555;">Regards,</p>
<p style="margin: 0; font-size: 12px; color: #555555;">The Paltech Team</p>
</div>
<div style="text-align: center;">
<p style="margin: 0 0 6px 0; font-size: 11px; color: #888888; font-weight: 700;">Joblink</p>
<p style="margin: 0; font-size: 10px; color: #aaaaaa; line-height: 1.5;">Connecting Jobs with Talent | 2026 The Paltech Team. All Rights Reserved.</p>
</div>
</div>
</td>
</tr>
</tbody>
</table>
</body>
</html>`;
};

const sendViaGmailSmtp = async ({ email, html, text }) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: process.env.GMAIL_SEND_EMAIL,
      pass: process.env.GMAIL_SEND_PASSWORD
    }
  });

  return transporter.sendMail({
    from: `Joblink <${process.env.GMAIL_SEND_EMAIL}>`,
    to: email,
    subject: 'Joblink Email Verification',
    html,
    text,
    encoding: 'utf-8',
    headers: {
      'X-Priority': '3 (Normal)',
      'X-MSMail-Priority': 'Normal',
      Importance: 'normal',
      'X-Mailer': 'Joblink',
      'Reply-To': process.env.GMAIL_SEND_EMAIL,
      'List-Unsubscribe': '<mailto:support@joblink.com?subject=unsubscribe>',
      'List-Id': 'Joblink <joblink.support@gmail.com>'
    }
  });
};

/**
 * Send verification code to email using Nodemailer
 */
const sendVerificationCode = async (email) => {
  try {
    
    

    // Debug: Check if env vars are loaded
    
    
    
    
    

    // Check if email is valid format first - allow +, -, ., _ and numbers
    const emailRegex = /^[a-z0-9._+\-]+@gmail\.com$/i;
    if (!emailRegex.test(email)) {
      return {
        success: false,
        message: 'Invalid Gmail format'
      };
    }

    // Generate verification code
    const code = generateVerificationCode();
    const expiresAt = Date.now() + CODE_EXPIRY_TIME;

    // Store the pending verification
    pendingVerifications.set(email.toLowerCase(), {
      code,
      expiresAt,
      attempts: 0
    });

    const emailTemplate = getEmailTemplate(code, email);
    const plainText = `Hello,\n\nYour Joblink email verification code is:\n\n${code}\n\nThis code is valid for 15 minutes and can only be used once.\n\nPlease don't share this code with anyone. Joblink support will never ask for your verification code.\n\nYou are receiving this email because a verification code was requested for you to be able to create Joblink account.\n\nIf you did not request this, ignore this email.\n\nBest regards,\nThe Joblink Team\n\n2026 Joblink. All rights reserved.`;
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.GMAIL_SEND_EMAIL || 'no-reply@joblink.com';

    if (EMAIL_VERIFICATION_METHOD === 'sendgrid') {
      if (!process.env.SENDGRID_API_KEY) {
        console.error('❌ CRITICAL: SendGrid API key missing from .env file');
        if (isGmailConfigured) {
          console.warn('⚠️ Falling back to Gmail SMTP because Gmail credentials are available.');
          EMAIL_VERIFICATION_METHOD = 'smtp';
        } else {
          return {
            success: false,
            message: 'Email service not configured. Missing SENDGRID_API_KEY in .env'
          };
        }
      }
    }

    if (EMAIL_VERIFICATION_METHOD === 'sendgrid') {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const msg = {
        to: email,
        from: `Joblink <${fromEmail}>`,
        subject: 'Joblink Email Verification',
        html: emailTemplate,
        text: plainText
      };

      try {
        await sgMail.send(msg);
        
        return {
          success: true,
          message: 'Verification code sent to your email',
          expiresIn: '10 minutes',
          sentTo: email
        };
      } catch (sendGridError) {
        const sendGridMessage = sendGridError?.response?.body?.errors?.[0]?.message || sendGridError.message || String(sendGridError);
        console.error('❌ SendGrid email sending failed:', sendGridMessage);

        if (isGmailConfigured) {
          try {
            console.warn('⚠️ SendGrid failed; attempting delivery through configured Gmail SMTP.');
            await sendViaGmailSmtp({ email, html: emailTemplate, text: plainText });
            
            return {
              success: true,
              message: 'Verification code sent to your email',
              expiresIn: '10 minutes',
              sentTo: email,
              provider: 'smtp-fallback'
            };
          } catch (smtpError) {
            console.error('❌ Gmail SMTP fallback failed:', smtpError.message || smtpError);
            return {
              success: false,
              message: 'SendGrid and Gmail SMTP both failed to send the verification email.',
              error: smtpError.message || String(smtpError),
              providerError: sendGridMessage
            };
          }
        }

        const creditsExhausted = /maximum credits exceeded|credits? (?:limit|exceeded)|quota/i.test(sendGridMessage);
        return {
          success: false,
          message: creditsExhausted
            ? 'SendGrid sending credits are exhausted. Add credits or configure Gmail SMTP.'
            : 'SendGrid rejected the email. Check the API key permissions and verified sender.',
          error: sendGridMessage
        };
      }
    }

    if (EMAIL_VERIFICATION_METHOD === 'smtp') {
      if (!process.env.GMAIL_SEND_EMAIL || !process.env.GMAIL_SEND_PASSWORD) {
        console.error('❌ CRITICAL: Gmail credentials missing from .env file');
        return {
          success: false,
          message: 'Email service not configured. Missing GMAIL_SEND_EMAIL or GMAIL_SEND_PASSWORD in .env'
        };
      }

      try {
        await sendViaGmailSmtp({ email, html: emailTemplate, text: plainText });

        
        return {
          success: true,
          message: 'Verification code sent to your email',
          expiresIn: '10 minutes',
          sentTo: email
        };
      } catch (emailError) {
        console.error(`❌ Email sending failed:`, emailError.message);
        console.error(`🔍 Full error details:`, JSON.stringify(emailError, null, 2));
        console.error(`🔍 Error code:`, emailError.code);
        console.error(`🔍 Response:`, emailError.response);
        
        return {
          success: false,
          message: 'Failed to send email. Please check SMTP settings.',
          error: emailError.message,
          errorCode: emailError.code,
          hint: 'Ensure Gmail App Password is correctly set in environment variables.'
        };
      }
    }
  } catch (error) {
    console.error('❌ Error in sendVerificationCode:', error);
    return {
      success: false,
      message: 'Failed to send verification code: ' + error.message
    };
  }
};

/**
 * Verify the code entered by user
 */
const verifyCode = async (email, code) => {
  try {
    const normalizedEmail = email.toLowerCase();
    const verification = pendingVerifications.get(normalizedEmail);

    if (!verification) {
      return {
        verified: false,
        message: 'No verification code sent for this email. Request a new one.'
      };
    }

    // Check if code expired
    if (Date.now() > verification.expiresAt) {
      pendingVerifications.delete(normalizedEmail);
      return {
        verified: false,
        message: 'Verification code expired. Request a new one.'
      };
    }

    // Check attempt limit
    if (verification.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      pendingVerifications.delete(normalizedEmail);
      return {
        verified: false,
        message: 'Too many attempts. Request a new verification code.'
      };
    }

    // Increment attempts
    verification.attempts++;

    // Check if code matches
    if (code.trim() === verification.code) {
      pendingVerifications.delete(normalizedEmail);
      
      // Mark as verified
      verifiedEmails.set(normalizedEmail, {
        verified: true,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + VERIFICATION_CACHE_TTL
      });

      
      return {
        verified: true,
        message: 'Email verified successfully!'
      };
    }

    // Wrong code
    const attemptsLeft = MAX_VERIFICATION_ATTEMPTS - verification.attempts;
    return {
      verified: false,
      message: `Wrong code. ${attemptsLeft} attempts remaining.`,
      attemptsLeft
    };

  } catch (error) {
    console.error('❌ Code verification error:', error);
    return {
      verified: false,
      message: 'Verification failed: ' + error.message
    };
  }
};

/**
 * Main verification function - Format validation only
 * Real verification happens via email code
 */
const verifyGoogleEmail = async (email) => {
  const normalizedEmail = email.toLowerCase();
  
  

  try {
    // Check if already verified
    const verified = verifiedEmails.get(normalizedEmail);
    if (verified && Date.now() < verified.expiresAt) {
      
      return {
        exists: true,
        verified: true,
        method: 'already-verified',
        email: email
      };
    }

    // Format check
    if (!normalizedEmail.endsWith('@gmail.com')) {
      return {
        exists: false,
        verified: false,
        method: 'not-gmail',
        email: email,
        reason: 'Only Gmail addresses are allowed'
      };
    }

    const [localPart, domain] = normalizedEmail.split('@');
    const localPartRegex = /^[a-z0-9._-]{1,64}$/;
    
    if (!localPartRegex.test(localPart)) {
      return {
        exists: false,
        verified: false,
        method: 'invalid-format',
        email: email,
        reason: 'Invalid Gmail username format'
      };
    }

    // Format is valid - return status
    const hasPendingCode = pendingVerifications.has(normalizedEmail);
    
    return {
      exists: true,
      verified: false,
      method: 'format-valid',
      email: email,
      requiresVerification: true,
      codeAlreadySent: hasPendingCode,
      message: hasPendingCode 
        ? 'Verification code already sent. Check your email.' 
        : 'Valid Gmail format. Send verification code to proceed.'
    };

  } catch (error) {
    console.error('❌ Format check error:', error);
    return {
      exists: false,
      verified: false,
      method: 'error',
      error: error.message
    };
  }
};

/**
 * Get cache stats for monitoring
 */
const getCacheStats = () => {
  return {
    pendingVerifications: pendingVerifications.size,
    verifiedEmails: verifiedEmails.size,
    pendingList: Array.from(pendingVerifications.keys()),
    verifiedList: Array.from(verifiedEmails.keys())
  };
};

module.exports = {
  verifyGoogleEmail,
  sendVerificationCode,
  verifyCode,
  getCacheStats,
  pendingVerifications,
  verifiedEmails,
  isValidSendGridApiKey
};
