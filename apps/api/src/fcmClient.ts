import { createSign, createHash } from 'node:crypto';
import type { AppConfig } from '@nvara/config';
import { logger } from './logger.js';

export type FcmSendResult = {
  success: boolean;
  status: 'SENT' | 'FAILED' | 'REVOKED' | 'SKIPPED';
  errorCode?: string;
  errorMessage?: string;
  messageId?: string;
};

export type FcmMessagePayload = {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  icon?: string;
  badge?: string;
  clickAction?: string;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(String(token || '').trim()).digest('hex');
}

export function tokenFingerprint(token: string): string {
  return hashToken(token).slice(0, 12);
}

// Token cache for Google OAuth2 Access Token
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(config: AppConfig): Promise<string | null> {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = config;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60) {
    return cachedAccessToken.token;
  }

  // Format private key properly (replacing escaped newlines if passed in env)
  const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

  // Create JWT Header and Claims
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimSet = Buffer.from(
    JSON.stringify({
      iss: FIREBASE_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  ).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${claimSet}`);
  const signature = sign.sign(privateKey, 'base64url');
  const assertion = `${header}.${claimSet}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    logger.error('Failed to obtain Google OAuth2 access token for FCM', { status: tokenRes.status, err: errText });
    return null;
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in || 3600),
  };
  return cachedAccessToken.token;
}

// Test / Mock handler hook for integration tests
export type FcmTransportOverride = (payload: FcmMessagePayload) => Promise<FcmSendResult>;
let fcmTransportOverride: FcmTransportOverride | null = null;

export function setFcmTransportOverride(override: FcmTransportOverride | null) {
  fcmTransportOverride = override;
}

export async function sendFcmPushNotification(
  payload: FcmMessagePayload,
  config: AppConfig
): Promise<FcmSendResult> {
  if (fcmTransportOverride) {
    return fcmTransportOverride(payload);
  }

  const fingerprint = tokenFingerprint(payload.token);

  // If Firebase is not configured in this environment, simulate safe skip
  if (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
    logger.info('FCM credentials not configured, skipping external web push delivery', {
      tokenFingerprint: fingerprint,
      title: payload.title,
    });
    return {
      success: true,
      status: 'SKIPPED',
      messageId: `simulated-fcm-${Date.now()}`,
    };
  }

  try {
    const accessToken = await getGoogleAccessToken(config);
    if (!accessToken) {
      return {
        success: false,
        status: 'FAILED',
        errorCode: 'AUTH_FAILED',
        errorMessage: 'Unable to authenticate with Google OAuth2 for FCM',
      };
    }

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/messages:send`;

    const fcmMessage = {
      message: {
        token: payload.token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data ?? {},
        webpush: {
          headers: {
            Urgency: 'high',
          },
          notification: {
            title: payload.title,
            body: payload.body,
            icon: payload.icon || '/favicon.ico',
            badge: payload.badge || '/favicon.ico',
            click_action: payload.clickAction || '/',
            data: payload.data ?? {},
          },
          fcm_options: {
            link: payload.clickAction || '/',
          },
        },
      },
    };

    const response = await fetch(fcmUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fcmMessage),
    });

    if (response.ok) {
      const respData = (await response.json()) as { name?: string };
      logger.info('FCM Web Push delivered successfully', {
        tokenFingerprint: fingerprint,
        messageId: respData.name,
      });
      return {
        success: true,
        status: 'SENT',
        messageId: respData.name,
      };
    }

    const status = response.status;
    const errBody = await response.json().catch(() => ({}));
    const fcmError = (errBody as any)?.error?.details?.[0]?.errorCode || (errBody as any)?.error?.status || String(status);
    const fcmMessageText = (errBody as any)?.error?.message || response.statusText;

    // Detect invalid / unregistered tokens for automatic cleanup
    const isUnregistered =
      status === 404 ||
      status === 410 ||
      fcmError === 'UNREGISTERED' ||
      fcmError === 'INVALID_ARGUMENT' ||
      fcmMessageText.includes('registration-token-not-registered') ||
      fcmMessageText.includes('Requested entity was not found');

    if (isUnregistered) {
      logger.warn('FCM token is unregistered or invalid; marking device for revocation', {
        tokenFingerprint: fingerprint,
        errorCode: fcmError,
      });
      return {
        success: false,
        status: 'REVOKED',
        errorCode: fcmError,
        errorMessage: fcmMessageText,
      };
    }

    logger.error('FCM send failed with non-fatal error', {
      tokenFingerprint: fingerprint,
      status,
      errorCode: fcmError,
      message: fcmMessageText,
    });

    return {
      success: false,
      status: 'FAILED',
      errorCode: fcmError,
      errorMessage: fcmMessageText,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('FCM delivery exception', {
      tokenFingerprint: fingerprint,
      error: errorMsg,
    });
    return {
      success: false,
      status: 'FAILED',
      errorCode: 'NETWORK_ERROR',
      errorMessage: errorMsg,
    };
  }
}
