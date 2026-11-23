import { config } from './config.js';

export interface GoogleTokens {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export async function exchangeGoogleCode(code: string, redirectUri: string, codeVerifier: string): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const res = await fetch(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  return res.json() as Promise<GoogleTokens>;
}

export function buildGoogleAuthUrl(opts: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): string {
  const u = new URL(config.google.authUrl);
  u.searchParams.set('client_id', config.google.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'select_account');
  u.searchParams.set('state', opts.state);
  u.searchParams.set('nonce', opts.nonce);
  u.searchParams.set('code_challenge', opts.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// id_token の検証は crypto.ts の verifyGoogleIdToken を使用（JWKS 署名 + iss/aud/exp/nonce）
