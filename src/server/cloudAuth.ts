import { getIntegration, upsertIntegration, deleteIntegration } from '../db.js';
import { encryptJson, decryptJson } from '../integrations.js';

// ---- BlockWhiz クラウドアカウント（Auth Server）クライアント ----
// Auth Server は独立した HTTPS サービス。デスクトップ側は
// CRAFTMATE_AUTH_URL で接続先を指定する。未設定時はクラウド認証を無効化する。
//
// セキュリティ方針:
// - https:// 必須。http:// は 127.0.0.1/localhost のみ許可（ローカル開発用）。
// - パスワードはサーバーへ送信するのみで、ローカルには一切保存しない。
// - Access/Refresh Token は integrations テーブルの '__cloud_auth_session' 行に
//   encryptJson（AES-256-GCM）で保存する。ログには一切出力しない。
// - Refresh Token はサーバー側でローテーションされる。再利用検知・失効時は
//   ローカルセッションを安全に削除して再ログインを要求する。

const CLOUD_SESSION_PLATFORM = '__cloud_auth_session';
const REQUEST_TIMEOUT_MS = 15000;

export interface CloudUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: CloudUser | null;
}

interface StoredCloudSession {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number; // epoch ms
  user: CloudUser;
  loginAt: number;
}

function authBaseUrl(): string | null {
  const raw = (process.env.CRAFTMATE_AUTH_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === 'https:') return u.origin;
  // ローカル開発用: loopback の http のみ許可
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) {
    return u.origin;
  }
  return null; // 非https・非loopback は拒否
}

export function cloudAuthConfigured(): boolean {
  return authBaseUrl() !== null;
}

async function apiRequest(path: string, body?: unknown, accessToken?: string): Promise<{ status: number; data: any }> {
  const base = authBaseUrl();
  if (!base) throw new Error('cloud auth is not configured');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}

// GET 用（/auth/me は GET）
async function apiGet(path: string, accessToken: string): Promise<{ status: number; data: any }> {
  const base = authBaseUrl();
  if (!base) throw new Error('cloud auth is not configured');
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}

// ---------- セッション保存（integrations テーブル・AES-256-GCM） ----------
export function getCloudSession(): StoredCloudSession | null {
  try {
    const row = getIntegration(CLOUD_SESSION_PLATFORM);
    if (!row || row.status !== 'connected' || !row.payload) return null;
    const data = decryptJson<StoredCloudSession>(row.payload);
    if (!data || !data.accessToken || !data.refreshToken || !data.user?.id) return null;
    return data;
  } catch { return null; }
}

// register/login 成功時にトークンを保存する公開関数
export function saveCloudSessionForLogin(tokens: CloudTokens): StoredCloudSession {
  return saveCloudSession(tokens);
}

function saveCloudSession(tokens: CloudTokens): StoredCloudSession {
  const session: StoredCloudSession = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: Date.now() + (Number(tokens.expiresIn) || 600) * 1000,
    user: tokens.user || { id: '', email: null, displayName: null, avatarUrl: null },
    loginAt: Date.now(),
  };
  upsertIntegration(CLOUD_SESSION_PLATFORM, 'connected', encryptJson(session));
  return session;
}

export function clearCloudSession(): void {
  try { deleteIntegration(CLOUD_SESSION_PLATFORM); } catch { /* ignore */ }
}

// ---------- API ----------
export async function cloudRegister(email: string, password: string, displayName?: string): Promise<CloudTokens> {
  const { status, data } = await apiRequest('/auth/register', { email, password, displayName });
  if (status !== 200 || !data?.accessToken) {
    const err = new Error(data?.error || 'registration failed') as Error & { code?: string; status?: number };
    err.code = data?.code; err.status = status;
    throw err;
  }
  return data as CloudTokens;
}

export async function cloudLogin(email: string, password: string): Promise<CloudTokens> {
  const { status, data } = await apiRequest('/auth/login', { email, password });
  if (status !== 200 || !data?.accessToken) {
    const err = new Error(data?.error || 'login failed') as Error & { code?: string; status?: number };
    err.code = data?.code; err.status = status;
    throw err;
  }
  return data as CloudTokens;
}

export async function cloudChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const session = getCloudSession();
  if (!session) throw new Error('not logged in');
  // 期限切れ間近なら先にリフレッシュ
  await ensureFreshAccessToken();
  const fresh = getCloudSession();
  if (!fresh) throw new Error('not logged in');
  const { status, data } = await apiRequest('/auth/password/change',
    { currentPassword, newPassword }, fresh.accessToken);
  if (status !== 200) {
    const err = new Error(data?.error || 'password change failed') as Error & { code?: string };
    err.code = data?.code;
    throw err;
  }
  // サーバー側で全セッション失効 → ローカルもログアウト状態にする
  clearCloudSession();
}

export async function cloudLogout(): Promise<void> {
  const session = getCloudSession();
  if (session?.refreshToken) {
    try { await apiRequest('/auth/logout', { refreshToken: session.refreshToken }); } catch { /* ignore */ }
  }
  clearCloudSession();
}

export async function cloudMe(): Promise<CloudUser | null> {
  const session = getCloudSession();
  if (!session) return null;
  await ensureFreshAccessToken();
  const fresh = getCloudSession();
  if (!fresh) return null;
  const { status, data } = await apiGet('/auth/me', fresh.accessToken);
  if (status !== 200) return null;
  return {
    id: String(data.id || fresh.user.id),
    email: data.email ?? fresh.user.email,
    displayName: data.displayName ?? fresh.user.displayName,
    avatarUrl: data.avatarUrl ?? fresh.user.avatarUrl,
  };
}

// ---------- トークンリフレッシュ ----------
// Access Token が期限60秒前を切ったら Refresh Token で更新する。
// サーバー側でローテーション＋再利用検知されるため、失敗時はセッションを削除する。
let refreshInflight: Promise<boolean> | null = null;

export function ensureFreshAccessToken(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    const session = getCloudSession();
    if (!session) return false;
    // まだ有効なら何もしない
    if (session.tokenExpiresAt > Date.now() + 60_000) return true;
    try {
      const { status, data } = await apiRequest('/auth/session/refresh', { refreshToken: session.refreshToken });
      if (status === 200 && data?.accessToken && data?.refreshToken) {
        saveCloudSession({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          tokenType: data.tokenType || 'Bearer',
          expiresIn: Number(data.expiresIn) || 600,
          user: data.user || session.user,
        });
        return true;
      }
      // 401/403 = トークン無効・再利用検知・失効 → ローカルセッション削除
      if (status === 401 || status === 403) {
        clearCloudSession();
        return false;
      }
      // 5xx/ネットワーク障害 → 一時的。セッションは保持して次回再試行
      return true;
    } catch {
      // ネットワーク障害 → セッション保持
      return true;
    }
  })().finally(() => { refreshInflight = null; });
  return refreshInflight;
}

// craftmate_user 識別子（外部ID連携・内部データの所有者解決に使用）
export function cloudCraftmateUser(): string | null {
  const s = getCloudSession();
  return s ? `cloud:${s.user.id}` : null;
}

// ---------- Phase D: メール確認・パスワードリセット・アカウント削除 ----------

export async function cloudRequestEmailVerification(email: string): Promise<void> {
  const { status, data } = await apiRequest('/auth/email/verify/request', { email });
  if (status !== 200) throw new Error(data?.error || 'request failed');
}

export async function cloudConfirmEmailVerification(token: string): Promise<void> {
  // POST /auth/email/verify/confirm（GET は確認ページ表示のみでトークンを消費しない）
  const { status, data } = await apiRequest('/auth/email/verify/confirm', { token });
  if (status !== 200) {
    const err = new Error(data?.error || 'verification failed') as Error & { code?: string };
    err.code = data?.code;
    throw err;
  }
}

export async function cloudRequestPasswordReset(email: string): Promise<void> {
  const { status, data } = await apiRequest('/auth/password/reset/request', { email });
  if (status !== 200) throw new Error(data?.error || 'request failed');
}

export async function cloudConfirmPasswordReset(token: string, newPassword: string): Promise<void> {
  const { status, data } = await apiRequest('/auth/password/reset/confirm', { token, newPassword });
  if (status !== 200) {
    const err = new Error(data?.error || 'reset failed') as Error & { code?: string };
    err.code = data?.code;
    throw err;
  }
  // リセット成功 → 全セッション失効済みなのでローカルもクリア
  clearCloudSession();
}

export async function cloudDeleteAccount(password?: string): Promise<void> {
  const session = getCloudSession();
  if (!session) throw new Error('not logged in');
  await ensureFreshAccessToken();
  const fresh = getCloudSession();
  if (!fresh) throw new Error('not logged in');
  const { status, data } = await apiRequest('/auth/account/delete',
    { password: password || '' }, fresh.accessToken);
  if (status !== 200) {
    const err = new Error(data?.error || 'delete failed') as Error & { code?: string };
    err.code = data?.code;
    throw err;
  }
  clearCloudSession();
}

export async function cloudChangeEmail(newEmail: string): Promise<void> {
  const session = getCloudSession();
  if (!session) throw new Error('not logged in');
  await ensureFreshAccessToken();
  const fresh = getCloudSession();
  if (!fresh) throw new Error('not logged in');
  const { status, data } = await apiRequest('/auth/email/change',
    { newEmail }, fresh.accessToken);
  if (status !== 200) {
    const err = new Error(data?.error || 'email change failed') as Error & { code?: string };
    err.code = data?.code;
    throw err;
  }
}
