import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { MinecraftBot } from '../bot/mcBot.js';
import { AutonomousAgent } from '../ai/agent.js';
import { captureScreenRegion } from '../bot/vision.js';
import { AgentStepLog, ChatMessage } from '../types.js';
import * as fs from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { spawn, execFile } from 'child_process';
import dotenv from 'dotenv';
import {
  listChatRooms, createChatRoom, deleteChatRoom, renameChatRoom, listChatMessages, addChatMessage, setChatRoomTitleIfEmpty,
  listReviews, addReview,
  listIntegrations, getIntegration, upsertIntegration, deleteIntegration,
  getLocalUser, createLocalUser, verifyLocalPassword,
  upsertExternalIdentity, listExternalIdentities, getExternalIdentity,
} from '../db.js';
import {
  INTEGRATION_PROVIDERS, getProvider, buildAuthorizeUrl, exchangeCode,
  generatePkce, generateState, encryptJson, decryptJson, summarizeAccount,
  providerUsesNonce, fetchProviderProfile, refreshAccessToken, verifyIdToken, mergeRefreshedTokens,
  resolveCraftmateUser,
  type IntegrationProvider,
} from '../integrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_ENV_KEYS = {
  gemini: 'GEMINI_MODEL',
  groq: 'GROQ_MODEL',
  ollama: 'OLLAMA_MODEL',
  openai: 'OPENAI_MODEL',
} as const;
type AIProvider = keyof typeof MODEL_ENV_KEYS;


export class WebServer {
  private app: express.Express;
  private server: http.Server;
  private io: SocketIOServer;
  private botWrapper: MinecraftBot;
  private agent: AutonomousAgent;
  private port: number;
  private statusTimer: NodeJS.Timeout | null = null;
  private envPath: string;
  private isScreenSharing: boolean = false;
  private screenShareSocket: any = null;
  private screenShareInterval: NodeJS.Timeout | null = null;
  private lastScreenFrameAt: number | null = null;
  private updateToken: Buffer = Buffer.alloc(32);
  private appVersion: string = '0.0.0';
  private selfCheckTimer: NodeJS.Timeout | null = null;
  private selfCheckFailures: number = 0;
  private lastSelfRestartAt: number = 0;
  private tempCleanupTimer: NodeJS.Timeout | null = null;
  private loopLagTimer: NodeJS.Timeout | null = null;
  private loopLagCount: number = 0;
  private connectedSockets: number = 0;
  private lastSocketActivityAt: number = Date.now();
  private idleShutdownTimer: NodeJS.Timeout | null = null;
  private updateCheckCache: { at: number; data: any } | null = null;
  // 統合版（Bedrock）機能は bedrock-app/ のゲーム内アドオンへ移行。
  // 旧 /api/bedrock/* および /api/bedrock-pack は削除済み。
  // 進行中の OAuth フロー: platform -> { state, codeVerifier, clientId, clientSecret, createdAt, purpose }
  private pendingOAuth: Map<string, { state: string; codeVerifier?: string; clientId: string; clientSecret?: string; createdAt: number; purpose?: 'login' | 'integration'; nonce?: string; craftmateUser?: string }> = new Map();


  constructor(
    botWrapper: MinecraftBot,
    agent: AutonomousAgent,
    port: number = 3000,
    envPath: string = path.resolve(__dirname, '../../.env')
  ) {
    this.botWrapper = botWrapper;
    this.agent = agent;
    this.port = port;
    this.envPath = envPath;
    try {
      this.updateToken = this.loadUpdateToken();
    } catch (error) {
      console.error('[Web] Failed to load update token:', error);
      this.updateToken = Buffer.alloc(32);
    }
    try {
      const packageInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
      this.appVersion = String(packageInfo.version || '0.0.0');
    } catch { }

    this.app = express();
    this.server = http.createServer(this.app);
    // polling トランスポートは長時間保持される GET/POST で、HTTPパーサーの
    // 状態を壊して「ボディ付きリクエストが全てハングする」wedged 状態を
    // 引き起こす可能性があるため、WebSocket 専用にする。
    // ローカルダッシュボード用途では polling の必要性がない。
    this.io = new SocketIOServer(this.server, {
      cors: { origin: '*' },
      transports: ['websocket'],
    });
    this.installEarlyBodyCapture();

    this.setupMiddlewares();
    this.setupRoutes();
    this.setupSocketEvents();
    this.setupBotEvents();
  }

  /**
   * ログインセッションを integrations テーブルの '__auth_session' 行から復号する。
   * provider='local'（旧スキップセッション）は無効として扱う。
   */
  private getAuthSession(): { provider: string; account: { label?: string; detail?: string } | null; loginAt: number; craftmateUser?: string } | null {
    try {
      const row = getIntegration('__auth_session');
      if (!row || row.status !== 'connected') return null;
      const data = decryptJson<any>(row.payload);
      if (!data || !data.provider || data.provider === 'local') return null;
      if (data.expiresAt && Date.now() > data.expiresAt) return null;
      // craftmate_user 識別子: 新規セッションは payload に保存済み。
      // 旧セッションは provider + account から推定する。
      const craftmateUser = data.craftmateUser
        || (data.provider === 'internal' ? `local:${data.account?.label || 'unknown'}` : `oauth:${data.provider}`);
      return { provider: String(data.provider), account: data.account || null, loginAt: data.loginAt || 0, craftmateUser };
    } catch {
      return null;
    }
  }

  // ---- OAuth トークン自動更新 ----
  // refresh_token を持つプロバイダ（Google/Discord、および expiring tokens が
  // 有効な GitHub）のみ更新する。GitHub OAuth Apps は通常 refresh_token を発行しないため
  // refresh_token が無ければ何もしない（＝自動更新されないのが正常）。
  private tokenRefreshInflight = new Map<string, Promise<void>>();

  /** トークン期限判定。tokenExpiresAt 優先、無ければ発行時刻+expires_in で推定（旧データ互換） */
  private tokenExpiryMs(data: any): number | null {
    const direct = Number(data?.tokenExpiresAt);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const issuedAt = Number(data?.connectedAt || data?.loginAt || 0);
    const expiresIn = Number(data?.expires_in || data?.tokenData?.expires_in || 0);
    if (issuedAt > 0 && Number.isFinite(expiresIn) && expiresIn > 0) return issuedAt + expiresIn * 1000;
    return null;
  }

  /** 期限切れ60秒前を「要更新」とみなす */
  private tokenNeedsRefresh(data: any): boolean {
    if (!data || !data.refresh_token) return false;
    const exp = this.tokenExpiryMs(data);
    return exp !== null && Date.now() > exp - 60_000;
  }

  /** refresh_token でトークンを更新し、マージ済みペイロードを返す。更新不可なら null */
  private async doRefreshTokenData(provider: IntegrationProvider, tokenData: any): Promise<any | null> {
    const refreshToken = String(tokenData.refresh_token || '');
    const clientId = String(tokenData.clientId || '');
    if (!refreshToken || !clientId) return null;
    const fresh = await refreshAccessToken(provider, {
      refreshToken,
      clientId,
      clientSecret: tokenData.clientSecret ? String(tokenData.clientSecret) : undefined,
    });
    const merged = mergeRefreshedTokens(tokenData, fresh);
    // 新しい id_token が来た場合は署名検証してから採用（nonce は refresh grant では通常含まれない）
    if (fresh.id_token && providerUsesNonce(provider)) {
      try {
        const claims = await verifyIdToken(provider.id, String(fresh.id_token), { clientId });
        if (claims.sub) {
          merged.profile = { ...(tokenData.profile || {}), providerUserId: String(claims.sub) };
        }
      } catch { /* id_token 検証失敗時は既存 profile を維持 */ }
    }
    return merged;
  }

  /** 恒久的な認証失敗（再認証が必要）か一時的な障害かを判定 */
  private isPermanentAuthError(msg: string): boolean {
    return /invalid_grant|invalid_client|unauthorized_client|bad_refresh_token/i.test(msg);
  }

  /** 連携プロバイダのトークンを必要に応じて更新（同時実行は1本に集約） */
  private refreshIntegration(platform: string): Promise<void> {
    const existing = this.tokenRefreshInflight.get(platform);
    if (existing) return existing;
    const job = (async () => {
      const provider = getProvider(platform);
      if (!provider) return;
      const row = getIntegration(platform);
      if (!row || row.status !== 'connected' || !row.payload) return;
      const data = decryptJson<any>(row.payload);
      if (!this.tokenNeedsRefresh(data)) return;
      try {
        const merged = await this.doRefreshTokenData(provider, data);
        if (!merged) {
          // refresh_token も clientId も無いのに期限切れ → 再認証要求
          upsertIntegration(platform, 'error', encryptJson({ ...data, needsReauth: true, reauthReason: 'no_refresh_token' }));
          this.debugLog(`token refresh: ${platform} needs reauth (no refresh token)`);
          return;
        }
        upsertIntegration(platform, 'connected', encryptJson(merged));
        this.debugLog(`token refreshed: ${platform}`);
      } catch (e) {
        const msg = (e as Error).message;
        this.debugLog(`token refresh failed: ${platform} ${msg}`);
        if (this.isPermanentAuthError(msg)) {
          const data2 = decryptJson<any>(row.payload) || {};
          upsertIntegration(platform, 'error', encryptJson({ ...data2, needsReauth: true, reauthReason: msg.slice(0, 200) }));
        }
        // 一時的障害（ネットワーク等）は connected のまま次回再試行
      }
    })().finally(() => { this.tokenRefreshInflight.delete(platform); });
    this.tokenRefreshInflight.set(platform, job);
    return job;
  }

  /** __auth_session のトークンを更新。恒久的失敗時はセッション削除（再ログイン要求） */
  private refreshAuthSession(): Promise<void> {
    const existing = this.tokenRefreshInflight.get('__auth_session');
    if (existing) return existing;
    const job = (async () => {
      const row = getIntegration('__auth_session');
      if (!row || row.status !== 'connected' || !row.payload) return;
      const data = decryptJson<any>(row.payload);
      if (!data || data.provider === 'internal' || !data.tokenData) return;
      if (!this.tokenNeedsRefresh(data.tokenData)) return;
      const provider = getProvider(String(data.provider));
      if (!provider) return;
      try {
        const merged = await this.doRefreshTokenData(provider, data.tokenData);
        if (!merged) {
          deleteIntegration('__auth_session');
          this.debugLog('auth session refresh: no refresh token, session cleared');
          return;
        }
        upsertIntegration('__auth_session', 'connected', encryptJson({ ...data, tokenData: merged }));
        this.debugLog(`auth session token refreshed: ${data.provider}`);
      } catch (e) {
        const msg = (e as Error).message;
        this.debugLog(`auth session refresh failed: ${data.provider} ${msg}`);
        if (this.isPermanentAuthError(msg)) deleteIntegration('__auth_session');
      }
    })().finally(() => { this.tokenRefreshInflight.delete('__auth_session'); });
    this.tokenRefreshInflight.set('__auth_session', job);
    return job;
  }

  private setupMiddlewares(): void {
    this.app.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
    // body-parser/express.json は環境によってボディ読み取りがハングする
    // 「wedged」状態が観測されたため、タイムアウト付きの独自パーサーに置き換える
    this.app.use((req, res, next) => this.readJsonBody(req, res, next));
    const publicPath = path.resolve(__dirname, '../../public');
    // ダッシュボード本体はサーバー側でも認証を強制する。
    // 未ログインの直接アクセス（/ および /index.html）はログイン画面へ。
    this.app.get('/', (req, res) => {
      if (!this.getAuthSession()) return res.redirect('/login.html');
      try {
        let html = fs.readFileSync(path.join(publicPath, 'index.html'), 'utf8');
        html = html.replace(/(src|href)="(\/?)(app\.js|i18n\.js|style\.css|manifest\.json)(\?[^"]*)?"/g, `$1="$2$3?v=${this.appVersion}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html.replace('</head>', `<meta name="craftmate-update-token" content="${this.updateToken.toString('hex')}"></head>`));
      } catch {
        res.status(500).send('Dashboard could not be loaded.');
      }
    });
    // /index.html への直接アクセスも / に集約して認証ゲートを通す
    this.app.get('/index.html', (_req, res) => res.redirect('/'));
    this.app.use(express.static(publicPath, { index: false }));
    this.app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      const parseError = error as { status?: number; type?: string };
      if (parseError && (parseError.type === 'entity.parse.failed' || parseError.status === 400)) {
        return res.status(400).json({ error: 'The request body must contain valid JSON.', code: 'INVALID_JSON' });
      }
      next(error);
    });
  }

  /**
   * wedged対策: JSONボディをサーバーの 'request' イベント最速段階でバッファする。
   * Express到達前に何らかの理由で req が resume/flowing 化され 'data'/'end' が
   * 誰にも届かず破棄されるケースを根絶する。socket.io の polling パスは除外する
   * （Engine.IO が自身でボディを読むため）。
   */
  private installEarlyBodyCapture(): void {
    this.server.prependListener('request', (req, res) => {
      try {
        const url = req.url || '';
        if (url.startsWith('/socket.io')) return;
        const method = (req.method || '').toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const wantsJson = mime === 'application/json' || mime.endsWith('+json');
        if (!wantsJson) return;
        const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0;
        if (!hasBody) return;

        const r = req as any;
        r.__jsonBodyChunks = [] as Buffer[];
        r.__jsonBodyBytes = 0;
        r.__jsonBodyDone = false;
        r.__jsonBodyError = false;
        r.__jsonBodyTooLarge = false;
        req.on('data', (chunk: Buffer) => {
          if (r.__jsonBodyTooLarge) return;
          r.__jsonBodyBytes += chunk.length;
          if (r.__jsonBodyBytes > 512 * 1024) {
            r.__jsonBodyTooLarge = true;
            return;
          }
          r.__jsonBodyChunks.push(chunk);
        });
        const finish = () => {
          if (r.__jsonBodyDone) return;
          r.__jsonBodyDone = true;
        };
        req.on('end', finish);
        req.on('error', () => { r.__jsonBodyError = true; finish(); });
        req.on('aborted', () => { r.__jsonBodyError = true; finish(); });
        req.on('close', () => { if (!req.complete) { r.__jsonBodyError = true; finish(); } });
      } catch { }
    });
  }

  /**
   * JSONボディを読み取る独自ミドルウェア。
   * body読み取りが10秒を超えた場合は408を返して無限ハングを防ぐ。
   * wedged状態の検出・自動復旧は startSelfCheck() のウォッチドッグが担当する。
   */
  private readJsonBody(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const method = req.method.toUpperCase();
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const wantsJson = mime === 'application/json' || mime.endsWith('+json');
    const declaresBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0;

    if (!wantsJson || !declaresBody || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      // JSON以外のボディは読み捨てて接続を健全に保つ
      if (declaresBody) req.resume();
      (req as any).body = {};
      next();
      return;
    }

    const r = req as any;
    // installEarlyBodyCapture がバッファ済みならそれを使う（最も確実）
    const useEarlyBuffer = Array.isArray(r.__jsonBodyChunks);

    const finishWithBody = (): void => {
      if (r.__jsonBodyTooLarge) {
        try { res.status(413).json({ error: 'Payload too large.', code: 'PAYLOAD_TOO_LARGE' }); } catch { }
        return;
      }
      try {
        const chunks: Buffer[] = useEarlyBuffer ? r.__jsonBodyChunks : [];
        const text = Buffer.concat(chunks).toString('utf8');
        (req as any).body = text ? JSON.parse(text) : {};
        next();
      } catch {
        res.status(400).json({ error: 'The request body must contain valid JSON.', code: 'INVALID_JSON' });
      }
    };

    if (useEarlyBuffer) {
      // バッファ完了をポーリング（'end' がミドルウェア到達前に発火済みでも拾える）
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (!r.__jsonBodyDone) {
          if (Date.now() - startedAt > 10000) {
            clearInterval(poll);
            console.error('[Web] Request body timed out (possible wedged state):', req.method, req.url,
              `bytes=${r.__jsonBodyBytes} flowing=${req.readableFlowing} ended=${req.readableEnded} complete=${req.complete}`);
            try { res.status(408).json({ error: 'Request body timed out. The server is unresponsive and will restart automatically.', code: 'BODY_TIMEOUT' }); } catch { }
            try { req.resume(); } catch { }
          }
          return;
        }
        clearInterval(poll);
        finishWithBody();
      }, 20);
      (poll as any).unref?.();
      // 既に完了済みなら即時処理
      if (r.__jsonBodyDone) { clearInterval(poll); finishWithBody(); }
      return;
    }

    // フォールバック: early capture が無い場合はストリームを直接読む
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error('[Web] Request body timed out (fallback path):', req.method, req.url);
      try {
        res.status(408).json({ error: 'Request body timed out. The server is unresponsive and will restart automatically.', code: 'BODY_TIMEOUT' });
      } catch { }
      try { req.resume(); } catch { }
    }, 10000);
    (timer as any).unref?.();

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > 256 * 1024) {
        settled = true;
        clearTimeout(timer);
        try { res.status(413).json({ error: 'Payload too large.', code: 'PAYLOAD_TOO_LARGE' }); } catch { }
        try { req.resume(); } catch { }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        (req as any).body = text ? JSON.parse(text) : {};
      } catch {
        res.status(400).json({ error: 'The request body must contain valid JSON.', code: 'INVALID_JSON' });
        return;
      }
      next();
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      next();
    });
  }

  private installationPath(): string {
    return path.resolve(__dirname, '../..');
  }

  private loadUpdateToken(): Buffer {
    const tokenDirectory = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local'), 'CraftMate');
    const tokenPath = path.join(tokenDirectory, 'update-token');
    try {
      fs.mkdirSync(tokenDirectory, { recursive: true });
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) return Buffer.from(existing, 'hex');
    } catch { }
    const token = randomBytes(32);
    fs.writeFileSync(tokenPath, token.toString('hex'), { mode: 0o600 });
    return token;
  }

  private isLocalUpdateRequest(req: express.Request, requireToken: boolean): boolean {
    const reject = (reason: string): boolean => {
      this.debugLog(`isLocalUpdateRequest rejected (${req.method} ${req.url}): ${reason}` +
        ` remote=${req.socket.remoteAddress} host=${req.headers.host} origin=${req.headers.origin || '-'} referer=${req.headers.referer || '-'} sec-fetch-site=${req.headers['sec-fetch-site'] || '-'} auth=${req.headers.authorization ? 'present' : 'missing'}`);
      return false;
    };

    const address = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
    if (address !== '127.0.0.1' && address !== '::1') return reject('non-loopback remote address');
    const host = String(req.headers.host || '').toLowerCase();
    if (!host) return reject('missing Host header');

    const originHeader = req.headers.origin;
    let originValue = typeof originHeader === 'string' ? originHeader : '';
    if (!originValue && typeof req.headers.referer === 'string') {
      try { originValue = new URL(req.headers.referer).origin; } catch { return reject('unparseable Referer'); }
    }
    // Origin/Referer がある場合は Host と同一オリジンであることを要求する。
    // ホスト名は localhost/127.0.0.1/LAN IP のいずれでも許可する
    // （ユーザーが http://<PC名>:3000 や LAN IP でダッシュボードを開くケースがあるため）。
    if (originValue) {
      try {
        const origin = new URL(originValue);
        if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return reject('non-http(s) origin');
        if (origin.host.toLowerCase() !== host) return reject(`origin/host mismatch: origin=${origin.host} host=${host}`);
      } catch { return reject('unparseable Origin'); }
    } else {
      // Origin も Referer も無い場合はブラウザの fetch メタデータで same-origin を確認
      const sfs = String(req.headers['sec-fetch-site'] || '');
      if (sfs !== 'same-origin' && sfs !== 'none') return reject('no origin/referer and sec-fetch-site=' + (sfs || 'missing'));
    }
    if (!requireToken) return true;

    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ') ? Buffer.from(authorization.slice(7), 'hex') : Buffer.alloc(0);
    if (supplied.length === this.updateToken.length && timingSafeEqual(supplied, this.updateToken)) return true;

    // トークンが無い/不一致の場合でも、ブラウザが same-origin と明示している
    // リクエストは許可する（クロスサイトからは sec-fetch-site: same-origin に
    // ならないため、他サイトからの悪用は防げる）。
    const sfs = String(req.headers['sec-fetch-site'] || '');
    if (sfs === 'same-origin' || sfs === 'none') {
      this.debugLog(`isLocalUpdateRequest: token missing/invalid but allowing same-origin browser request (${req.method} ${req.url})`);
      return true;
    }
    return reject('invalid or missing bearer token');
  }

  /** 設定保存の診断ログを %TEMP%\CraftMate_server.log に追記（APIキー等の秘密値はマスク） */
  private debugLog(message: string): void {
    try {
      const line = `[${new Date().toISOString()}] ${message}\n`;
      fs.promises.appendFile(path.join(os.tmpdir(), 'CraftMate_server.log'), line, 'utf8').catch(() => { });
      console.log('[Debug]', message);
    } catch { }
  }

  private maskSecrets(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /key|secret|token|password/i.test(k) && typeof v === 'string' && v.length > 0
        ? `<set:${v.length}chars>` : v;
    }
    return out;
  }

  // "1.2.3" 形式のバージョン比較。a > b なら正、a < b なら負、同じなら0。
  private compareVersions(a: string, b: string): number {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  private setupRoutes(): void {
    this.app.get('/api/version', (req, res) => {
      try {
        const packagePath = path.resolve(__dirname, '../../package.json');
        const packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        res.json({ version: String(packageInfo.version || '0.0.0'), platform: process.platform, arch: process.arch });
      } catch {
        res.status(500).json({ error: 'Could not read the application version.' });
      }
    });

    // GitHub 最新リリースと現在バージョンを比較し、自OS用アセット名を返す。
    // 結果は10分キャッシュ（GitHub API のレート制限対策）。
    this.app.get('/api/version/check', async (req, res) => {
      const repo = 'kurageno8156-lgtm/craftmate-payload';
      const current = this.appVersion || '0.0.0';
      const platform = process.platform;
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      try {
        const now = Date.now();
        if (!this.updateCheckCache || now - this.updateCheckCache.at > 10 * 60 * 1000) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          const gh = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'User-Agent': 'CraftMate', Accept: 'application/vnd.github+json' },
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!gh.ok) throw new Error(`GitHub API ${gh.status}`);
          const data = await gh.json() as { tag_name?: string; html_url?: string; assets?: Array<{ name: string; browser_download_url: string }> };
          this.updateCheckCache = { at: now, data };
        }
        const rel = this.updateCheckCache.data;
        const latest = String(rel.tag_name || '').replace(/^v/, '');
        const updateAvailable = this.compareVersions(latest, current) > 0;
        // 自OS用アセット名の決定（他OSのファイルは絶対に選ばない）
        let assetName = '';
        if (platform === 'win32') assetName = 'CraftMate_Setup.exe';
        else if (platform === 'linux') assetName = `CraftMate-linux-${arch}.AppImage`;
        else if (platform === 'darwin') assetName = '';
        const asset = (rel.assets || []).find((a: { name: string }) => a.name === assetName);
        // Electron デスクトップ版（AppImage/deb）は CRAFTMATE_DESKTOP=1 が
        // 設定されるため、Linux でもアプリ内アップデートを有効化する。
        // ポータブル tarball（ブラウザ利用）は従来通り手動ダウンロード。
        const canAutoUpdate = platform === 'win32' ||
          (platform === 'linux' && process.env.CRAFTMATE_DESKTOP === '1');
        this.debugLog(`GET /api/version/check -> platform=${platform} arch=${arch} current=${current} latest=${latest || 'none'} updateAvailable=${updateAvailable} asset=${asset ? assetName : 'none'} canAutoUpdate=${canAutoUpdate}`);
        res.json({
          currentVersion: current,
          latestVersion: latest || null,
          updateAvailable,
          platform,
          arch,
          assetName: asset ? assetName : null,
          downloadUrl: asset ? asset.browser_download_url : null,
          releaseUrl: rel.html_url || null,
          canAutoUpdate,
        });
      } catch (error) {
        this.debugLog(`GET /api/version/check failed: ${(error as Error).message}`);
        res.json({
          currentVersion: current, latestVersion: null, updateAvailable: false,
          platform, arch, assetName: null, downloadUrl: null,
          releaseUrl: `https://github.com/${repo}/releases/latest`,
          canAutoUpdate: platform === 'win32' ||
            (platform === 'linux' && process.env.CRAFTMATE_DESKTOP === '1'),
          checkError: 'Could not reach GitHub to check for updates.',
        });
      }
    });

    this.app.post('/api/launch-updater', (req, res) => {
      const startedAt = Date.now();
      this.debugLog('POST /api/launch-updater start');
      if (process.platform !== 'win32') {
        this.debugLog(`POST /api/launch-updater rejected: auto-updater is Windows-only (platform=${process.platform})`);
        return res.status(400).json({
          error: 'The built-in updater is only available on Windows. Please download the latest release manually.',
          manualUpdate: true,
          platform: process.platform,
        });
      }
      if (!this.isLocalUpdateRequest(req, true)) {
        this.debugLog('POST /api/launch-updater rejected: not a local authenticated request');
        return res.status(403).json({ error: 'The updater can be launched only from the authenticated local dashboard.' });
      }
      // 起動前に、以前のバージョンで残った CraftMate 補助プロセスを掃除する。
      // （Updater本体はこれから起動するので対象外。node.exe/Launcher.exe の掃除は Updater 側が行う）
      for (const staleName of ['CraftMate_Updater', 'CraftMate_ScreenViewer']) {
        try {
          execFile('taskkill', ['/F', '/IM', `${staleName}.exe`], { timeout: 5000 }, () => { });
        } catch { /* ベストエフォート */ }
      }
      const updaterPath = path.join(this.installationPath(), 'CraftMate_Updater.exe');
      if (!fs.existsSync(updaterPath)) {
        this.debugLog(`POST /api/launch-updater failed: updater not found at ${updaterPath}`);
        return res.status(404).json({ error: 'CraftMate_Updater.exe was not found. Reinstall CraftMate to add the updater.' });
      }
      try {
        const child = spawn(updaterPath, ['--install-dir', this.installationPath()], {
          cwd: this.installationPath(), detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.once('error', error => {
          this.debugLog(`POST /api/launch-updater spawn error: ${error.message}`);
          console.error('[Updater] Could not start the desktop updater:', error);
          // フォールバック: cmd.exe の start 経由で起動を試みる
          try {
            const fallback = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', updaterPath, '--install-dir', this.installationPath()], {
              cwd: this.installationPath(), detached: true, stdio: 'ignore', windowsHide: true,
            });
            fallback.once('error', e => this.debugLog(`launch-updater fallback spawn error: ${e.message}`));
            fallback.unref();
            this.debugLog('launch-updater fallback via cmd.exe start issued');
          } catch (fallbackError) {
            this.debugLog(`launch-updater fallback failed: ${(fallbackError as Error).message}`);
          }
        });
        child.once('exit', (code, signal) => {
          this.debugLog(`launch-updater child exited code=${code} signal=${signal}`);
        });
        child.unref();
        this.debugLog(`POST /api/launch-updater spawned pid=${child.pid} ${Date.now() - startedAt}ms`);
        res.status(202).json({ success: true });
      } catch (error) {
        this.debugLog(`POST /api/launch-updater FAILED ${Date.now() - startedAt}ms: ${(error as Error).message}`);
        console.error('[Updater] Could not start the desktop updater:', error);
        res.status(500).json({ error: 'Could not start CraftMate_Updater.exe.' });
      }
    });

    this.app.post('/api/launch-screen-viewer', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'The screen viewer can be launched only from the authenticated local dashboard.' });

      const candidates = [
        path.join(this.installationPath(), 'CraftMate_ScreenViewer.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CraftMate', 'CraftMate_ScreenViewer.exe'),
      ].filter(Boolean);
      const viewerPath = candidates.find(candidate => fs.existsSync(candidate));
      if (!viewerPath) {
        return res.status(404).json({
          error: 'CraftMate_ScreenViewer.exe was not found. Reinstall or update CraftMate to add the screen viewer.',
          searched: candidates,
        });
      }
      try {
        const child = spawn(viewerPath, ['--port', String(this.port)], {
          cwd: path.dirname(viewerPath), detached: true, stdio: 'ignore', windowsHide: false,
        });
        child.once('error', error => {
          console.error('[ScreenViewer] Could not start the screen viewer:', error);
          // フォールバック: cmd.exe 経由で起動を試みる
          try {
            const fallback = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${viewerPath}" --port ${this.port}`], {
              detached: true, stdio: 'ignore', windowsHide: false,
            });
            fallback.once('error', e => console.error('[ScreenViewer] Fallback launch also failed:', e));
            fallback.unref();
          } catch (fallbackError) {
            console.error('[ScreenViewer] Fallback launch failed:', fallbackError);
          }
        });
        child.once('exit', code => {
          if (code !== 0 && code !== null) {
            console.warn(`[ScreenViewer] Process exited unexpectedly with code ${code}.`);
          }
        });
        child.unref();
        console.log('[ScreenViewer] Launched:', viewerPath);
        res.status(202).json({ success: true, path: viewerPath });
      } catch (error) {
        console.error('[ScreenViewer] Could not start the screen viewer:', error);
        res.status(500).json({ error: `Could not start CraftMate_ScreenViewer.exe: ${(error as Error).message}` });
      }
    });

    this.app.get('/api/backup', (req, res) => {
      const startedAt = Date.now();
      this.debugLog(`GET /api/backup start remote=${req.socket.remoteAddress}`);
      if (!this.isLocalUpdateRequest(req, true)) {
        this.debugLog('GET /api/backup rejected: not a local authenticated request');
        return res.status(403).json({ error: 'Backups are available only to the authenticated local dashboard.' });
      }
      try {
        let env = '';
        try { env = fs.readFileSync(this.envPath, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, '0');
        const fileName = `craftmate_backup_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ format: 'craftmate-settings-backup', version: 1, createdAt: now.toISOString(), fileName, env });
        this.debugLog(`GET /api/backup done ${Date.now() - startedAt}ms fileName=${fileName}`);
      } catch (error) {
        this.debugLog(`GET /api/backup FAILED ${Date.now() - startedAt}ms: ${(error as Error).message}`);
        console.error('[Backup] Could not read .env:', error);
        res.status(500).json({ error: 'Could not create a settings backup.' });
      }
    });

    this.app.post('/api/restore', async (req, res) => {
      const startedAt = Date.now();
      this.debugLog(`POST /api/restore start`);
      if (!this.isLocalUpdateRequest(req, true)) {
        this.debugLog('POST /api/restore rejected: not a local authenticated request');
        return res.status(403).json({ error: 'Restore is available only to the authenticated local dashboard.' });
      }
      const body = req.body as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'This is not a supported CraftMate settings backup.', code: 'INVALID_BACKUP_DATA' });
      }
      const backup = body as { format?: unknown; version?: unknown; env?: unknown; createdAt?: unknown; fileName?: unknown };
      if (backup.format !== 'craftmate-settings-backup' || backup.version !== 1 || typeof backup.env !== 'string' ||
          (backup.createdAt !== undefined && (typeof backup.createdAt !== 'string' || !Number.isFinite(Date.parse(backup.createdAt)))) ||
          (backup.fileName !== undefined && (typeof backup.fileName !== 'string' || !/^craftmate_backup_\d{8}_\d{6}\.json$/.test(backup.fileName)))) {
        return res.status(400).json({ error: 'This is not a supported CraftMate settings backup.', code: 'INVALID_BACKUP_DATA' });
      }
      if (Buffer.byteLength(backup.env, 'utf8') > 128 * 1024 || backup.env.includes('\0')) {
        return res.status(413).json({ error: 'The backup file is too large or contains invalid data.', code: 'INVALID_BACKUP_DATA' });
      }

      let values: Record<string, string>;
      try { values = dotenv.parse(backup.env); }
      catch { return res.status(400).json({ error: 'The backup settings could not be parsed.', code: 'INVALID_BACKUP_DATA' }); }
      const knownSettings = ['MC_HOST', 'MC_PORT', 'MC_USERNAME', 'MINECRAFT_VERSION', 'WEB_PORT', 'LLM_PROVIDER', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_MODEL'];
      if (!Object.keys(values).some(key => knownSettings.includes(key))) {
        return res.status(400).json({ error: 'The backup does not contain CraftMate settings.', code: 'INVALID_BACKUP_DATA' });
      }
      const providers = ['gemini', 'groq', 'openai', 'ollama'];
      const provider = values.LLM_PROVIDER || 'gemini';
      const mcPort = Number(values.MC_PORT || 25565);
      const webPort = Number(values.WEB_PORT || 3000);
      const username = values.MC_USERNAME || 'AIMAN';
      const auth = values.MC_AUTH || 'offline';
      const minecraftVersion = values.MINECRAFT_VERSION || 'auto';
      if (!providers.includes(provider)) return res.status(400).json({ error: 'The backup contains an unsupported AI provider.' });
      if (!Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535 || !Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
        return res.status(400).json({ error: 'The backup contains an invalid port number.' });
      }
      if (!/^[A-Za-z0-9_]{1,16}$/.test(username) || (auth !== 'offline' && auth !== 'microsoft')) {
        return res.status(400).json({ error: 'The backup contains invalid Minecraft settings.' });
      }
      if (minecraftVersion.toLowerCase() !== 'auto' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(minecraftVersion)) {
        return res.status(400).json({ error: 'The backup contains an invalid Minecraft version.' });
      }
      for (const key of Object.values(MODEL_ENV_KEYS)) {
        if (values[key] && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(values[key])) {
          return res.status(400).json({ error: `The backup contains an invalid model value (${key}).` });
        }
      }
      for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY']) {
        if (values[key] && (values[key].length > 512 || /[\r\n]/.test(values[key]))) {
          return res.status(400).json({ error: `The backup contains an invalid API key value (${key}).`, code: 'INVALID_BACKUP_DATA' });
        }
      }
      if (values.OLLAMA_BASE_URL) {
        try {
          const ollamaUrl = new URL(values.OLLAMA_BASE_URL);
          if (!['http:', 'https:'].includes(ollamaUrl.protocol)) throw new Error('unsupported protocol');
        } catch { return res.status(400).json({ error: 'The backup contains an invalid Ollama URL.', code: 'INVALID_BACKUP_DATA' }); }
      }
      for (const key of ['AUTO_EAT', 'AUTO_ARMOR']) {
        if (values[key] && !['true', 'false'].includes(values[key].toLowerCase())) {
          return res.status(400).json({ error: `The backup contains an invalid value for ${key}.`, code: 'INVALID_BACKUP_DATA' });
        }
      }

      const config = this.botWrapper.config;
      const previousEnv = (() => {
        try { return dotenv.parse(fs.readFileSync(this.envPath, 'utf8')); } catch { return {}; }
      })();
      const portChanged = webPort !== this.port;
      const minecraftChanged = mcPort !== config.mcPort || username !== config.mcUsername ||
        (values.MC_HOST || 'localhost') !== config.mcHost || auth !== config.mcAuth || minecraftVersion !== (config.mcVersion || 'auto');
      const temporaryPath = `${this.envPath}.restore-${randomBytes(8).toString('hex')}`;
      try {
        await fs.promises.writeFile(temporaryPath, backup.env, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await this.renameFileWithRetry(temporaryPath, this.envPath);
      } catch (error) {
        try { fs.rmSync(temporaryPath, { force: true }); } catch { }
        console.error('[Restore] Could not replace .env:', error);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          return res.status(500).json({ error: 'Access was denied while replacing .env. The CraftMate install folder may require write permission.', code: 'RESTORE_PERMISSION_DENIED' });
        }
        return res.status(500).json({ error: 'Could not restore the settings file. Close applications that may be locking .env and try again.', code: 'RESTORE_WRITE_FAILED' });
      }

      for (const key of Object.keys(previousEnv)) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(values)) process.env[key] = value;

      config.mcHost = values.MC_HOST || 'localhost';
      config.mcPort = mcPort;
      config.mcUsername = username;
      config.mcAuth = auth as 'offline' | 'microsoft';
      config.mcVersion = minecraftVersion;
      config.llmProvider = provider as AIProvider;
      config.geminiApiKey = values.GEMINI_API_KEY || '';
      config.geminiModel = values.GEMINI_MODEL || 'gemini-3.1-flash-lite';
      config.openaiApiKey = values.OPENAI_API_KEY || '';
      config.openaiModel = values.OPENAI_MODEL || 'gpt-4o';
      config.groqApiKey = values.GROQ_API_KEY || '';
      config.groqModel = values.GROQ_MODEL || 'openai/gpt-oss-120b';
      config.ollamaBaseUrl = values.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      config.ollamaModel = values.OLLAMA_MODEL || 'llama3.1';
      config.webPort = webPort;
      config.autoEat = values.AUTO_EAT !== 'false';
      config.autoArmor = values.AUTO_ARMOR !== 'false';
      config.botAllowCommands = values.BOT_ALLOW_COMMANDS !== 'false';
      config.botAllowDangerousCommands = values.BOT_ALLOW_DANGEROUS_COMMANDS !== 'false';
      config.botAllowFileOps = values.BOT_ALLOW_FILE_OPS !== 'false';
      config.botAllowAutoguard = values.BOT_ALLOW_AUTOGUARD !== 'false';
      config.maxAgentSteps = 100;
      this.agent.restartAIClient();
      if (minecraftChanged) this.botWrapper.reconnect();

      this.debugLog(`POST /api/restore .env replaced OK ${Date.now() - startedAt}ms portChanged=${portChanged} mcChanged=${minecraftChanged}`);
      res.json({ success: true, reconnecting: minecraftChanged, webPortChanged: portChanged, webPort, provider, model: this.getModelName() });
      if (portChanged) setTimeout(() => this.changePort(webPort), 300);
      this.debugLog(`POST /api/restore done ${Date.now() - startedAt}ms`);
    });

    this.app.get('/api/status', (req, res) => {
      const status = this.botWrapper.getStatus(
        this.agent.getCurrentTask(),
        this.agent.isBusy()
      );
      res.json({
        connected: this.botWrapper.isConnected,
        status,
        screenSharing: this.isScreenSharing,
        lastScreenFrameAt: this.lastScreenFrameAt,
        config: {
          username: this.botWrapper.config.mcUsername,
          host: this.botWrapper.config.mcHost,
          port: this.botWrapper.config.mcPort,
          provider: this.botWrapper.config.llmProvider,
          model: this.getModelName(),
        },
      });
    });

    this.app.get('/api/health', async (req, res) => {
      const minecraftConnected = this.botWrapper.isConnected;
      const aiConnected = await this.checkAIConnection();
      res.json({ minecraftConnected, aiConnected });
    });

    this.app.get('/api/settings', (req, res) => {
      const config = this.botWrapper.config;
      res.json({
        mcPort: config.mcPort,
        mcVersion: config.mcVersion || 'auto',
        username: config.mcUsername,
        webPort: this.port,
        provider: config.llmProvider,
        model: this.getModelName(),
        apiKeyConfigured: this.isProviderConfigured(),
        botAllowCommands: config.botAllowCommands,
        botAllowDangerousCommands: config.botAllowDangerousCommands,
        botAllowFileOps: config.botAllowFileOps,
        botAllowAutoguard: config.botAllowAutoguard,
      });
    });

    this.app.post('/api/settings', async (req, res) => {
      const { mcPort, mcVersion, username, webPort, provider, model, aiApiKey,
        botAllowCommands, botAllowDangerousCommands, botAllowFileOps, botAllowAutoguard } = req.body || {};
      const parsedMcPort = Number(mcPort);
      const parsedWebPort = Number(webPort);
      const providers = Object.keys(MODEL_ENV_KEYS) as AIProvider[];

      if (!Number.isInteger(parsedMcPort) || parsedMcPort < 1 || parsedMcPort > 65535) {
        return res.status(400).json({ error: 'Minecraft port must be between 1 and 65535.' });
      }
      const selectedMinecraftVersion = typeof mcVersion === 'string' ? mcVersion.trim() : 'auto';
      if (selectedMinecraftVersion.toLowerCase() !== 'auto' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(selectedMinecraftVersion)) {
        return res.status(400).json({ error: 'Enter auto or a valid Minecraft version such as 1.21.1.' });
      }
      if (selectedMinecraftVersion !== 'auto') {
        const versionParts = selectedMinecraftVersion.split('.').map(part => {
          const n = Number(part);
          if (!Number.isInteger(n) || String(n) !== part.trim()) return NaN;
          return n;
        });
        if (versionParts.some(n => Number.isNaN(n))) {
          return res.status(400).json({ error: 'Enter auto or a valid Minecraft version such as 1.21.1.' });
        }
        const major = versionParts[0];
        const minor = versionParts[1] || 0;
        const patch = versionParts[2] || 0;
        if (major > 26 || (major === 26 && minor > 1) || (major === 26 && minor === 1 && patch > 0)) {
          return res.status(400).json({ error: 'Minecraft version must be 26.1 or lower.' });
        }
      }
      if (!Number.isInteger(parsedWebPort) || parsedWebPort < 1 || parsedWebPort > 65535) {
        return res.status(400).json({ error: 'Web port must be between 1 and 65535.' });
      }
      if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(username.trim())) {
        return res.status(400).json({ error: 'Bot name must be 1–16 letters, numbers, or underscores.' });
      }
      if (typeof provider !== 'string' || !providers.includes(provider as AIProvider)) {
        return res.status(400).json({ error: 'Choose Gemini, Groq, Ollama, or OpenAI.' });
      }
      const selectedProvider = provider as AIProvider;
      const selectedModel = typeof model === 'string' ? model.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(selectedModel)) {
        return res.status(400).json({ error: 'Choose a valid model for the selected provider.' });
      }
      if (aiApiKey !== undefined && (typeof aiApiKey !== 'string' || aiApiKey.length > 512 || /[\r\n]/.test(aiApiKey))) {
        return res.status(400).json({ error: 'The API key is invalid.' });
      }

      const config = this.botWrapper.config;
      const portChanged = parsedWebPort !== this.port;
      const minecraftChanged = parsedMcPort !== config.mcPort || username.trim() !== config.mcUsername || selectedMinecraftVersion !== (config.mcVersion || 'auto');
      this.debugLog(`POST /api/settings received: ${JSON.stringify(this.maskSecrets(req.body))} envPath=${this.envPath}`);
      const updates: Record<string, string> = {
        MC_PORT: String(parsedMcPort),
        MINECRAFT_VERSION: selectedMinecraftVersion || 'auto',
        MC_USERNAME: username.trim(),
        WEB_PORT: String(parsedWebPort),
        LLM_PROVIDER: selectedProvider,
        [MODEL_ENV_KEYS[selectedProvider]]: selectedModel,
      };

      const keyName = selectedProvider === 'gemini' ? 'GEMINI_API_KEY' : selectedProvider === 'groq' ? 'GROQ_API_KEY' : selectedProvider === 'openai' ? 'OPENAI_API_KEY' : '';
      const trimmedKey = typeof aiApiKey === 'string' ? aiApiKey.trim() : '';
      if (keyName && trimmedKey) updates[keyName] = trimmedKey;

      const toBoolEnv = (value: unknown): string | null =>
        typeof value === 'boolean' ? (value ? 'true' : 'false') : null;
      const adminUpdates: Array<[string, string | null]> = [
        ['BOT_ALLOW_COMMANDS', toBoolEnv(botAllowCommands)],
        ['BOT_ALLOW_DANGEROUS_COMMANDS', toBoolEnv(botAllowDangerousCommands)],
        ['BOT_ALLOW_FILE_OPS', toBoolEnv(botAllowFileOps)],
        ['BOT_ALLOW_AUTOGUARD', toBoolEnv(botAllowAutoguard)],
      ];
      for (const [envKey, envValue] of adminUpdates) {
        if (envValue !== null) updates[envKey] = envValue;
      }

      try {
        await this.writeEnvUpdates(updates);
        this.debugLog(`POST /api/settings .env written OK: keys=${Object.keys(updates).join(',')} -> ${this.envPath}`);
      } catch (error) {
        this.debugLog(`POST /api/settings .env write FAILED: ${(error as Error).message} path=${this.envPath}`);
        console.error('[Settings] Could not save .env:', error);
        return res.status(500).json({ error: 'Could not save settings to .env.' });
      }

      config.mcPort = parsedMcPort;
      config.mcVersion = selectedMinecraftVersion || 'auto';
      config.mcUsername = username.trim();
      config.webPort = parsedWebPort;
      config.llmProvider = selectedProvider;
      if (selectedProvider === 'gemini') config.geminiModel = selectedModel;
      if (selectedProvider === 'groq') config.groqModel = selectedModel;
      if (selectedProvider === 'ollama') config.ollamaModel = selectedModel;
      if (selectedProvider === 'openai') config.openaiModel = selectedModel;
      for (const [envKey, envValue] of adminUpdates) {
        if (envValue !== null) {
          const cfgKey = envKey === 'BOT_ALLOW_COMMANDS' ? 'botAllowCommands'
            : envKey === 'BOT_ALLOW_DANGEROUS_COMMANDS' ? 'botAllowDangerousCommands'
            : envKey === 'BOT_ALLOW_FILE_OPS' ? 'botAllowFileOps'
            : 'botAllowAutoguard';
          (config as any)[cfgKey] = envValue === 'true';
        }
      }
      if (keyName && trimmedKey) {
        if (selectedProvider === 'gemini') config.geminiApiKey = trimmedKey;
        if (selectedProvider === 'groq') config.groqApiKey = trimmedKey;
        if (selectedProvider === 'openai') config.openaiApiKey = trimmedKey;
      }
      this.agent.restartAIClient();
      if (minecraftChanged) this.botWrapper.reconnect();
      this.debugLog(`POST /api/settings applied: portChanged=${portChanged} mcChanged=${minecraftChanged} provider=${selectedProvider} model=${selectedModel}`);

      res.json({ success: true, reconnecting: minecraftChanged, webPortChanged: portChanged, webPort: parsedWebPort, provider: selectedProvider, model: selectedModel, mcVersion: config.mcVersion });
      if (portChanged) {
        setTimeout(() => this.changePort(parsedWebPort), 300);
      }
    });

    this.app.post('/api/command', async (req, res) => {
      const { instruction, sender } = req.body || {};
      if (!instruction) {
        return res.status(400).json({ error: '指示(instruction)が必要です' });
      }
      this.debugLog(`POST /api/command: "${String(instruction).slice(0, 120)}"`);
      // handleInstruction は内部でキューイングされるため await しない（長時間タスクでAPIを塞がない）
      void this.agent.handleInstruction(instruction, sender || 'WebDashboard');
      res.json({ success: true, message: 'タスクを開始しました' });
    });

    this.app.post('/api/cancel', async (req, res) => {
      this.debugLog('POST /api/cancel');
      await this.agent.cancelTask();
      res.json({ success: true, message: 'タスクを中断しました' });
    });

    this.app.post('/api/reconnect', (req, res) => {
      const startedAt = Date.now();
      this.debugLog('POST /api/reconnect start');
      try {
        this.botWrapper.reconnect();
        this.debugLog(`POST /api/reconnect done ${Date.now() - startedAt}ms`);
        res.json({ success: true });
      } catch (error) {
        this.debugLog(`POST /api/reconnect FAILED ${Date.now() - startedAt}ms: ${(error as Error).message}`);
        res.status(500).json({ error: 'Reconnect failed.' });
      }
    });

    this.app.post('/api/ai/restart', (req, res) => {
      const startedAt = Date.now();
      this.debugLog('POST /api/ai/restart start');
      try {
        this.agent.restartAIClient();
        this.debugLog(`POST /api/ai/restart done ${Date.now() - startedAt}ms`);
        res.json({ success: true });
      } catch (error) {
        this.debugLog(`POST /api/ai/restart FAILED ${Date.now() - startedAt}ms: ${(error as Error).message}`);
        res.status(500).json({ error: 'AI restart failed.' });
      }
    });

    // ---- チャットルーム（SQLite 永続化）----
    // ---------- 外部サービス連携 ----------
    const integrationRedirectBase = () =>
      (process.env.CRAFTMATE_PUBLIC_URL || `http://127.0.0.1:${this.port}`).replace(/\/+$/, '');

    this.app.get('/api/integrations', async (req, res) => {
      if (!this.isLocalUpdateRequest(req, false)) return res.status(403).json({ error: 'Forbidden' });
      // 期限切れ間近のトークンを事前に更新（refresh_token がある場合のみ。失敗しても応答は返す）
      await Promise.allSettled(INTEGRATION_PROVIDERS.map(p => this.refreshIntegration(p.id)));
      const rows = new Map(listIntegrations().map(r => [r.platform, r]));
      const platforms = INTEGRATION_PROVIDERS.map(p => {
        const row = rows.get(p.id);
        let account: { label?: string; detail?: string } | null = null;
        if (row && row.status === 'connected') {
          const data = decryptJson(row.payload);
          if (data) account = summarizeAccount(p.id, data);
        }
        // OAuth クライアントが設定済みか（埋め込みファイル/環境変数）を UI に伝える
        let oauthConfigured: boolean | null = null;
        if (p.style === 'oauth') {
          try {
            const { clientId } = resolveOAuthClient(p.id, {}, p.clientIdEnv, p.clientSecretEnv);
            oauthConfigured = !!clientId;
          } catch { oauthConfigured = null; }
        }
        return {
          id: p.id,
          label: p.label,
          description: p.description,
          style: p.style,
          tokenHint: p.tokenHint || null,
          oauthConfigured,
          connected: !!(row && row.status === 'connected'),
          account,
          updatedAt: row ? row.updated_at : null,
        };
      });
      res.json({ platforms });
    });

    this.app.post('/api/integrations/:platform/connect', async (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Forbidden' });
      const provider = getProvider(String(req.params.platform));
      if (!provider) return res.status(404).json({ error: 'Unknown platform.' });
      const body = (req.body || {}) as { clientId?: string; clientSecret?: string; token?: string };

      // トークン貼り付けモード（または token が直接指定された場合）
      if (provider.style === 'token' || (typeof body.token === 'string' && body.token.trim())) {
        const token = String(body.token || '').trim();
        if (token.length < 8 || token.length > 4096) {
          return res.status(400).json({ error: 'Invalid token.' });
        }
        upsertIntegration(provider.id, 'connected', encryptJson({ token, type: 'bearer', connectedAt: Date.now() }));
        this.debugLog(`integration connect (token): ${provider.id}`);
        return res.json({ success: true, connected: true });
      }

      if (provider.style !== 'oauth' || !provider.authorizeUrl) {
        return res.status(400).json({ error: 'This platform does not support OAuth.' });
      }

      // clientId はリクエスト > .env > 埋め込み oauth-clients.json の順で解決
      const { clientId, clientSecret } = resolveOAuthClient(provider.id, body, provider.clientIdEnv, provider.clientSecretEnv);
      if (!clientId) {
        return res.status(400).json({ error: 'clientId is required (or set the corresponding env var).', code: 'CLIENT_ID_REQUIRED' });
      }

      const state = generateState();
      const { verifier, challenge } = generatePkce();
      const redirectUri = `${integrationRedirectBase()}/api/integrations/${provider.id}/oauth/callback`;
      const nonce = providerUsesNonce(provider) ? generateState() : undefined;
      // 既存アカウントへの追加連携は本人確認済みセッションを必須とする
      const session = this.getAuthSession();
      if (!session?.craftmateUser) {
        return res.status(401).json({ error: 'アカウント連携にはログインが必要です。', code: 'AUTH_REQUIRED' });
      }
      this.pendingOAuth.set(provider.id, { state, codeVerifier: verifier, clientId, clientSecret, createdAt: Date.now(), nonce, craftmateUser: session.craftmateUser });
      // 10分で期限切れにするため古いエントリを掃除
      const now = Date.now();
      for (const [k, v] of this.pendingOAuth) {
        if (now - v.createdAt > 10 * 60 * 1000) this.pendingOAuth.delete(k);
      }
      const authUrl = buildAuthorizeUrl(provider, { redirectUri, state, codeChallenge: challenge, clientId, nonce });
      this.debugLog(`integration oauth start: ${provider.id} redirect=${redirectUri}`);
      res.json({ success: true, authUrl, redirectUri });
    });

    // ---- 初回起動ログイン（OAuth 2.0 / OIDC）----
    // セッションは integrations テーブルの '__auth_session' 行に暗号化保存する。
    const AUTH_SESSION_PLATFORM = '__auth_session';

    // ビルド時に埋め込まれた OAuth クライアント情報（oauth-clients.json）。
    // 配置候補: ペイロードルート（dist/server から2階層上）、カレントディレクトリ、
    // Electron の resources/payload。最初に見つかったものを使う。
    const oauthClientCandidates = [
      path.resolve(__dirname, '../../oauth-clients.json'),
      path.resolve(process.cwd(), 'oauth-clients.json'),
      process.env.CRAFTMATE_RESOURCES_PATH ? path.join(process.env.CRAFTMATE_RESOURCES_PATH, 'payload', 'oauth-clients.json') : '',
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
        ? path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath as string, 'payload', 'oauth-clients.json')
        : '',
      // ユーザー配置用フォールバック: %LOCALAPPDATA%\CraftMate\oauth-clients.json
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CraftMate', 'oauth-clients.json') : '',
      process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'craftmate', 'oauth-clients.json') : '',
      path.join(os.homedir(), '.config', 'craftmate', 'oauth-clients.json'),
    ].filter(Boolean);
    let embeddedOAuthClientsPath: string | null = null;
    const embeddedOAuthClients = (() => {
      for (const p of oauthClientCandidates) {
        try {
          if (fs.existsSync(p)) {
            embeddedOAuthClientsPath = p;
            return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, { clientId?: string; clientSecret?: string }>;
          }
        } catch (e) {
          this.debugLog(`oauth-clients.json parse failed at ${p}: ${(e as Error).message}`);
        }
      }
      return {} as Record<string, { clientId?: string; clientSecret?: string }>;
    })();
    // 起動時に設定状況をログへ（シークレットは出力しない）
    {
      const configured = Object.keys(embeddedOAuthClients)
        .filter((k) => (embeddedOAuthClients[k]?.clientId || '').trim());
      this.debugLog(
        `oauth-clients: path=${embeddedOAuthClientsPath || '(not found)'} candidates=${oauthClientCandidates.join(' | ')} ` +
        `configured=[${configured.join(',')}] env=[${INTEGRATION_PROVIDERS.filter(p => p.clientIdEnv && process.env[p.clientIdEnv]).map(p => p.id).join(',')}]`
      );
    }
    const resolveOAuthClient = (providerId: string, body: { clientId?: string; clientSecret?: string }, clientIdEnv?: string, clientSecretEnv?: string) => {
      const embedded = embeddedOAuthClients[providerId] || {};
      const resolved = {
        clientId: (body.clientId || '').trim() || (clientIdEnv ? process.env[clientIdEnv] : '') || (embedded.clientId || '').trim(),
        clientSecret: (body.clientSecret || '').trim() || (clientSecretEnv ? process.env[clientSecretEnv] : '') || (embedded.clientSecret || '').trim() || undefined,
      };
      const source = (body.clientId || '').trim() ? 'request'
        : (clientIdEnv && process.env[clientIdEnv]) ? 'env'
        : (embedded.clientId || '').trim() ? 'embedded-file' : 'none';
      this.debugLog(`oauth resolve ${providerId}: clientId=${resolved.clientId ? resolved.clientId.slice(0, 12) + '…' : '(empty)'} source=${source} hasSecret=${!!resolved.clientSecret}`);
      return resolved;
    };

    this.app.get('/api/auth/status', async (req, res) => {
      if (!this.isLocalUpdateRequest(req, false)) return res.status(403).json({ error: 'Forbidden' });
      // セッションのアクセストークンが期限切れ間近なら更新を試行（失敗時は安全に再認証要求）
      await this.refreshAuthSession().catch(() => { });
      const session = this.getAuthSession();
      res.json({ authenticated: !!session, session });
    });

    this.app.post('/api/auth/login/:platform', async (req, res) => {
      if (!this.isLocalUpdateRequest(req, false)) return res.status(403).json({ error: 'Forbidden' });
      const provider = getProvider(String(req.params.platform));
      if (!provider) return res.status(404).json({ error: 'Unknown platform.' });
      if (provider.style !== 'oauth' || !provider.authorizeUrl) {
        return res.status(400).json({ error: 'This platform does not support OAuth login.' });
      }
      const body = (req.body || {}) as { clientId?: string; clientSecret?: string };
      const { clientId, clientSecret } = resolveOAuthClient(provider.id, body, provider.clientIdEnv, provider.clientSecretEnv);
      if (!clientId) {
        this.debugLog(`auth login rejected: ${provider.id} no clientId (file=${embeddedOAuthClientsPath || 'none'})`);
        return res.status(400).json({ error: 'clientId is required (or set the corresponding env var).', code: 'CLIENT_ID_REQUIRED' });
      }
      const state = generateState();
      const { verifier, challenge } = generatePkce();
      const redirectUri = `${integrationRedirectBase()}/api/integrations/${provider.id}/oauth/callback`;
      const nonce = providerUsesNonce(provider) ? generateState() : undefined;
      this.pendingOAuth.set(`login:${provider.id}`, { state, codeVerifier: verifier, clientId, clientSecret, createdAt: Date.now(), purpose: 'login', nonce });
      const authUrl = buildAuthorizeUrl(provider, { redirectUri, state, codeChallenge: challenge, clientId, nonce });
      this.debugLog(`auth login start: ${provider.id} redirect=${redirectUri}`);
      res.json({ success: true, authUrl });
    });

    // ---- 内部アカウント（OAuth が使えない場合のフォールバック認証）----
    // ユーザー名/パスワードを SQLite に保存し、セッションは OAuth と同じ
    // '__auth_session' 行（AES-256-GCM 暗号化）で管理する。
    const LOCAL_AUTH_PROVIDER = 'internal';
    const createLocalSession = (username: string) => {
      upsertIntegration('__auth_session', 'connected', encryptJson({
        provider: LOCAL_AUTH_PROVIDER,
        account: { label: username, detail: 'internal account' },
        craftmateUser: `local:${username}`,
        loginAt: Date.now(),
        expiresAt: null,
      }));
    };

    this.app.post('/api/auth/register', (req, res) => {
      if (!this.isLocalUpdateRequest(req, false)) return res.status(403).json({ error: 'Forbidden' });
      const { username, password } = (req.body || {}) as { username?: string; password?: string };
      const name = String(username || '').trim();
      const pass = String(password || '');
      if (!/^[A-Za-z0-9_\-]{3,32}$/.test(name)) {
        return res.status(400).json({ error: 'ユーザー名は 3〜32 文字の英数字・_・- で入力してください。' });
      }
      if (pass.length < 8 || pass.length > 128) {
        return res.status(400).json({ error: 'パスワードは 8 文字以上で入力してください。' });
      }
      if (getLocalUser(name)) {
        return res.status(409).json({ error: 'このユーザー名は既に使われています。' });
      }
      try {
        createLocalUser(name, pass);
        createLocalSession(name);
        this.debugLog(`auth register success: ${name}`);
        res.json({ success: true });
      } catch (e) {
        this.debugLog(`auth register failed: ${(e as Error).message}`);
        res.status(500).json({ error: 'アカウント作成に失敗しました。' });
      }
    });

    this.app.post('/api/auth/local-login', (req, res) => {
      if (!this.isLocalUpdateRequest(req, false)) return res.status(403).json({ error: 'Forbidden' });
      const { username, password } = (req.body || {}) as { username?: string; password?: string };
      const name = String(username || '').trim();
      const user = getLocalUser(name);
      if (!user || !verifyLocalPassword(String(password || ''), user.pass_hash)) {
        return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません。' });
      }
      createLocalSession(name);
      this.debugLog(`auth local-login success: ${name}`);
      res.json({ success: true });
    });

    this.app.post('/api/auth/logout', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Forbidden' });
      deleteIntegration(AUTH_SESSION_PLATFORM);
      this.debugLog('auth logout');
      res.json({ success: true });
    });

    this.app.get('/api/integrations/:platform/oauth/callback', async (req, res) => {
      const platform = String(req.params.platform);
      const provider = getProvider(platform);
      const finish = (ok: boolean, message: string) => {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        // window.open で開かれたウィンドウは script から閉じられる。
        // ダッシュボードへの復帰リンクも併記する。
        res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>CraftMate</title></head><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:480px"><h2 style="color:${ok ? '#4ade80' : '#f87171'}">${ok ? '連携が完了しました' : '連携に失敗しました'}</h2><p>${esc(message)}</p><p style="color:#71717a;font-size:13px">このウィンドウは自動で閉じます。閉じない場合は <a href="http://127.0.0.1:3000" style="color:#60a5fa">ダッシュボードに戻る</a> をクリックしてください。</p></div><script>try{if(window.opener){window.opener.postMessage({type:'craftmate:oauth-done',platform:${JSON.stringify(platform)},ok:${ok}},location.origin)}}catch(e){}setTimeout(function(){try{window.close()}catch(e){}},1200)</script></body></html>`);
      };
      if (!provider) return finish(false, 'Unknown platform.');
      const { code, state, error, error_description } = req.query as Record<string, string>;
      if (error) {
        this.debugLog(`oauth callback error: platform=${platform} error=${error} desc=${error_description || ''}`);
        let message = `${error}: ${error_description || ''}`;
        // Google の「テスト」公開ステータスでは未登録アカウントが access_denied になる
        if (platform === 'google' && error === 'access_denied') {
          message += '（このアカウントは Google Cloud Console の「テストユーザー」に登録されていない可能性があります）';
        }
        return finish(false, message);
      }
      const pending = this.pendingOAuth.get(platform) || this.pendingOAuth.get(`login:${platform}`);
      const pendingExpired = pending ? Date.now() - pending.createdAt > 10 * 60 * 1000 : false;
      if (!pending || pendingExpired || pending.state !== state || !code) {
        if (pendingExpired) { this.pendingOAuth.delete(platform); this.pendingOAuth.delete(`login:${platform}`); }
        return finish(false, '認証セッションが無効か期限切れです。もう一度お試しください。');
      }
      this.pendingOAuth.delete(platform);
      this.pendingOAuth.delete(`login:${platform}`);
      try {
        const redirectUri = `${integrationRedirectBase()}/api/integrations/${platform}/oauth/callback`;
        const tokenData = await exchangeCode(provider, {
          code, redirectUri,
          clientId: pending.clientId,
          clientSecret: pending.clientSecret,
          codeVerifier: pending.codeVerifier,
        });
        // プロバイダからユーザー情報を取得（id_token は署名/JWKS/iss/aud/exp/nonce を検証済み）
        const profile = await fetchProviderProfile(provider, tokenData, {
          clientId: pending.clientId,
          nonce: pending.nonce,
        });
        const enriched = {
          ...tokenData,
          profile,
          // リフレッシュに必要なクライアント情報とトークン期限を暗号化ペイロードに保持
          clientId: pending.clientId,
          clientSecret: pending.clientSecret,
          tokenExpiresAt: Number.isFinite(Number(tokenData.expires_in)) && Number(tokenData.expires_in) > 0
            ? Date.now() + Number(tokenData.expires_in) * 1000 : null,
        };
        const account = { label: profile.label, detail: profile.detail || platform };
        // provider + provider_user_id から CraftMate アカウントを解決する。
        // ログイン: 連携済みなら所有者アカウントでログイン、未連携なら新規アカウント。
        // 連携: ログイン中ユーザーに紐付け、別所有者なら拒否。
        const existingIdentity = profile.providerUserId
          ? getExternalIdentity(platform, profile.providerUserId) : null;
        const resolved = resolveCraftmateUser({
          purpose: pending.purpose,
          providerId: platform,
          providerUserId: profile.providerUserId,
          sessionUser: pending.craftmateUser,
          accountLabel: account.label,
          existingOwner: existingIdentity?.craftmate_user || null,
        });
        if (resolved.conflict) {
          this.debugLog(`external identity conflict: ${platform} owned by ${existingIdentity!.craftmate_user}, rejected for ${resolved.craftmateUser}`);
          return finish(false, 'この外部アカウントは既に別のCraftMateアカウントに連携されています。連携を解除してからやり直してください。');
        }
        const craftmateUser = resolved.craftmateUser;
        // 外部IDと CraftMate ユーザーの紐付けを記録（メール一致での自動統合は行わない）
        if (profile.providerUserId) {
          upsertExternalIdentity(platform, profile.providerUserId, craftmateUser, profile.name || profile.label || '', profile.email || '');
        }
        if (pending.purpose === 'login') {
          const expiresIn = Number(tokenData.expires_in);
          // refresh_token がある場合はアクセストークン期限でセッションを切らない
          // （トークン自動更新で延命する）。無い場合のみ expires_in をセッション期限に使う。
          const hasRefresh = !!tokenData.refresh_token;
          upsertIntegration('__auth_session', 'connected', encryptJson({
            provider: platform,
            account,
            craftmateUser,
            tokenData: enriched,
            clientId: pending.clientId,
            loginAt: Date.now(),
            expiresAt: !hasRefresh && Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
          }));
          // ログインに使ったプロバイダを「外部アカウント連携」でも連携済みにする
          upsertIntegration(platform, 'connected', encryptJson({
            ...enriched,
            clientId: pending.clientId,
            connectedAt: Date.now(),
            via: 'login',
          }));
          this.debugLog(`auth login success: ${platform} account=${account.label || '-'} (integration synced)`);
          return finish(true, `ログインが完了しました${account.label ? `（${account.label}）` : ''}。ダッシュボードに戻ってください。`);
        }
        upsertIntegration(platform, 'connected', encryptJson({
          ...enriched,
          clientId: pending.clientId,
          connectedAt: Date.now(),
        }));
        this.debugLog(`integration oauth success: ${platform} account=${account.label || '-'}`);
        return finish(true, `${provider.label} との連携が完了しました${account.label ? `（${account.label}）` : ''}。`);
      } catch (e) {
        this.debugLog(`integration oauth failed: ${platform} ${(e as Error).message}`);
        return finish(false, `トークン取得に失敗しました: ${(e as Error).message}`);
      }
    });

    this.app.post('/api/integrations/:platform/disconnect', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Forbidden' });
      const platform = String(req.params.platform);
      if (!getProvider(platform)) return res.status(404).json({ error: 'Unknown platform.' });
      deleteIntegration(platform);
      this.pendingOAuth.delete(platform);
      this.debugLog(`integration disconnect: ${platform}`);
      res.json({ success: true });
    });

    this.app.get('/api/chat-rooms', (_req, res) => {
      res.json({ rooms: listChatRooms() });
    });

    this.app.post('/api/ping', (_req, res) => {
      // JSONボディのパース経路を含む疎通確認用（自己診断ウォッチドッグが使用）
      res.json({ pong: true });
    });

    // ダッシュボードの「アプリを完全に終了」ボタン用。応答後にプロセスを終了する。
    this.app.post('/api/shutdown', (req, res) => {
      this.debugLog('POST /api/shutdown start');
      if (!this.isLocalUpdateRequest(req, true)) {
        this.debugLog('POST /api/shutdown rejected: not a local authenticated request');
        return res.status(403).json({ error: 'Shutdown is available only to the authenticated local dashboard.' });
      }
      this.debugLog('POST /api/shutdown accepted; exiting in 600ms');
      try { res.json({ success: true }); } catch { }
      setTimeout(() => process.exit(0), 600);
    });

    this.app.post('/api/chat-rooms', (req, res) => {
      const id = String(req.body?.id || `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const title = String(req.body?.title || '').slice(0, 100);
      res.json({ room: createChatRoom(id, title) });
    });

    this.app.delete('/api/chat-rooms/:id', (req, res) => {
      deleteChatRoom(String(req.params.id));
      res.json({ success: true });
    });

    this.app.post('/api/chat-rooms/:id/rename', (req, res) => {
      const title = String(req.body?.title || '').trim().slice(0, 100);
      if (!title) return res.status(400).json({ error: 'title is required' });
      renameChatRoom(String(req.params.id), title);
      res.json({ success: true });
    });

    this.app.get('/api/chat-rooms/:id/messages', (req, res) => {
      res.json({ messages: listChatMessages(String(req.params.id)) });
    });

    this.app.post('/api/chat-rooms/:id/messages', (req, res) => {
      const sender = String(req.body?.sender || 'user');
      const content = String(req.body?.content || '');
      if (!content) return res.status(400).json({ error: 'content is required' });
      const roomId = String(req.params.id);
      const message = addChatMessage(roomId, sender, content.slice(0, 4000));
      // 最初のユーザーメッセージをルーム名にする
      if (sender === 'user') setChatRoomTitleIfEmpty(roomId, content);
      res.json({ message });
    });

    // ---- レビュー（SQLite 永続化・全ユーザー共有）----
    this.app.get('/api/reviews', (_req, res) => {
      res.json(listReviews());
    });

    this.app.post('/api/reviews', (req, res) => {
      try {
        const rating = Math.max(1, Math.min(5, parseInt(String(req.body?.rating), 10) || 0));
        const name = String(req.body?.name || '').slice(0, 30);
        const comment = String(req.body?.comment || '').slice(0, 1000);
        this.debugLog(`POST /api/reviews received: rating=${req.body?.rating} nameLen=${name.length} commentLen=${comment.trim().length}`);
        if (!comment.trim()) {
          this.debugLog('POST /api/reviews rejected: empty comment');
          return res.status(400).json({ error: 'comment is required' });
        }
        const review = addReview(rating, name || '匿名', comment.trim());
        this.debugLog(`POST /api/reviews saved id=${review.id}`);
        res.json({ review });
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        this.debugLog(`POST /api/reviews FAILED: ${message}`);
        res.status(500).json({ error: `レビューの保存に失敗しました: ${message}` });
      }
    });
  }

  private getModelName(): string {
    const config = this.botWrapper.config;
    if (config.llmProvider === 'gemini') return config.geminiModel;
    if (config.llmProvider === 'groq') return config.groqModel;
    if (config.llmProvider === 'openai') return config.openaiModel;
    return config.ollamaModel;
  }

  private isProviderConfigured(): boolean {
    const config = this.botWrapper.config;
    if (config.llmProvider === 'gemini') return Boolean(config.geminiApiKey);
    if (config.llmProvider === 'groq') return Boolean(config.groqApiKey);
    if (config.llmProvider === 'openai') return Boolean(config.openaiApiKey);
    return true;
  }

  private async checkAIConnection(): Promise<boolean> {
    const config = this.botWrapper.config;
    let url: string;
    const headers: Record<string, string> = {};

    if (config.llmProvider === 'gemini') {
      if (!config.geminiApiKey) return false;
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.geminiApiKey)}`;
    } else if (config.llmProvider === 'groq') {
      if (!config.groqApiKey) return false;
      url = 'https://api.groq.com/openai/v1/models';
      headers.Authorization = `Bearer ${config.groqApiKey}`;
    } else if (config.llmProvider === 'openai') {
      if (!config.openaiApiKey) return false;
      url = 'https://api.openai.com/v1/models';
      headers.Authorization = `Bearer ${config.openaiApiKey}`;
    } else {
      const baseUrl = config.ollamaBaseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
      url = `${baseUrl}/api/tags`;
    }

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async writeEnvUpdates(updates: Record<string, string>): Promise<void> {
    const envPath = this.envPath;
    let content = '';
    try {
      content = fs.readFileSync(envPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    // 同一キーが複数行ある場合に備え、更新対象キーの既存行をすべて除去してから
    // 末尾に1行だけ書き直す（dotenv は後勝ちのため、残存する古い行が新値を上書きする事故を防ぐ）
    const updateKeys = new Set(Object.keys(updates));
    const kept = lines.filter(line => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !(match && updateKeys.has(match[1]));
    });
    for (const [key, value] of Object.entries(updates)) {
      kept.push(`${key}=${JSON.stringify(value)}`);
    }
    const output = `${kept.filter((line, index) => index < kept.length - 1 || line !== '').join('\n').trimEnd()}\n`;
    const retryDelays = [50, 100, 150];
    for (let attempt = 0; ; attempt += 1) {
      try {
        // 同期I/Oでイベントループを止めないよう非同期書き込みを使う
        await fs.promises.writeFile(envPath, output, 'utf8');
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || '';
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= retryDelays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }
    }
    for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  }

  private async renameFileWithRetry(source: string, destination: string): Promise<void> {
    const retryableErrors = new Set(['EBUSY', 'EACCES', 'EPERM']);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.promises.rename(source, destination);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || '';
        if (!retryableErrors.has(code) || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }

  private changePort(port: number): void {
    if (!this.server.listening) {
      this.port = port;
      this.server.listen(port);
      return;
    }

    this.server.close(error => {
      if (error) {
        console.error('[Web] Could not close the current listener:', error);
        return;
      }
      this.port = port;
      this.server.once('error', err => console.error(`[Web] Could not listen on port ${port}:`, err));
      this.server.listen(port, () => console.log(`[Web] Dashboard moved to http://localhost:${port}`));
    });
  }

  private setupSocketEvents(): void {
    this.io.on('connection', socket => {
      this.connectedSockets += 1;
      this.lastSocketActivityAt = Date.now();
      socket.onAny(() => { this.lastSocketActivityAt = Date.now(); });
      // Send current status immediately upon connection
      socket.emit('status', {
        connected: this.botWrapper.isConnected,
        status: this.botWrapper.getStatus(this.agent.getCurrentTask(), this.agent.isBusy()),
      });

      socket.on('sendInstruction', data => {
        if (data.instruction) {
          this.agent.handleInstruction(data.instruction, data.sender || 'WebUser');
        }
      });

      socket.on('cancelTask', async () => {
        await this.agent.cancelTask();
      });

      socket.on('start-screen-share', () => {
        if (!this.isScreenSharing) {
          this.isScreenSharing = true;
          this.screenShareSocket = socket;
          let capturing = false;
          this.screenShareInterval = setInterval(async () => {
            if (!this.isScreenSharing || capturing) return;
            capturing = true;
            try {
              // screenshot-desktop は1フレーム毎に cmd.exe+bat をspawnするため、
              // 高頻度だとプロセス生成が激しくなりサーバーが不安定になる。500ms間隔に抑える。
              const img = await captureScreenRegion(0, 0, 1920, 1080);
              if (img) {
                this.lastScreenFrameAt = Date.now();
                this.io.emit('bot-screen', img);
              }
            } catch (error) {
              console.error('[Web] Screen share capture failed:', error);
            } finally {
              capturing = false;
            }
          }, 500);
        }
      });

      socket.on('stop-screen-share', () => {
        this.isScreenSharing = false;
        this.screenShareSocket = null;
        this.lastScreenFrameAt = null;
        if (this.screenShareInterval) {
          clearInterval(this.screenShareInterval);
          this.screenShareInterval = null;
        }
      });

      socket.on('disconnect', () => {
        this.connectedSockets = Math.max(0, this.connectedSockets - 1);
        this.lastSocketActivityAt = Date.now();
        if (this.isScreenSharing && this.screenShareSocket === socket) {
          this.isScreenSharing = false;
          this.screenShareSocket = null;
          this.lastScreenFrameAt = null;
          if (this.screenShareInterval) {
            clearInterval(this.screenShareInterval);
            this.screenShareInterval = null;
          }
        }
      });
    });

    this.statusTimer = setInterval(() => {
      try {
        this.io.emit('status', {
          connected: this.botWrapper.isConnected,
          status: this.botWrapper.getStatus(this.agent.getCurrentTask(), this.agent.isBusy()),
        });
      } catch (error) {
        console.error('[Web] Could not broadcast status:', error);
      }
    }, 1000);
  }

  private setupBotEvents(): void {
    this.agent.on('stepLog', (log: AgentStepLog) => {
      this.io.emit('agentLog', log);
    });

    this.agent.on('taskStarted', data => {
      this.io.emit('taskStarted', data);
    });

    this.agent.on('taskFinished', data => {
      this.io.emit('taskFinished', data);
    });

    // AIがチャットで発言した内容をダッシュボードのチャットルームへ転送
    this.agent.on('aiChat', (data: { text: string; timestamp: string }) => {
      this.io.emit('aiChatMessage', data);
    });

    this.botWrapper.on('playerMessage', (chat: ChatMessage) => {
      this.debugLog(`MC chat <${chat.sender}>: ${String(chat.text).slice(0, 200)}`);
      this.io.emit('chatMessage', chat);
    });

    // ボットの接続ライフサイクルをサーバーログに記録（再接続不具合の切り分け用）
    this.botWrapper.on('connected', () => {
      this.debugLog(`Bot connected: ${this.botWrapper.config.mcHost}:${this.botWrapper.config.mcPort} as ${this.botWrapper.config.mcUsername}`);
    });
    this.botWrapper.on('spawned', () => {
      this.debugLog('Bot spawned in world.');
    });
    this.botWrapper.on('disconnected', () => {
      this.debugLog('Bot disconnected from Minecraft server.');
    });
    this.botWrapper.on('kicked', (reason: unknown) => {
      this.debugLog(`Bot kicked: ${String(reason)}`);
    });
    this.botWrapper.on('botError', (err: unknown) => {
      this.debugLog(`Bot error: ${(err as Error)?.message || String(err)}`);
    });
    this.botWrapper.on('botDied', () => {
      this.debugLog('Bot died.');
    });
  }

  public start(): void {
    const tryListen = (attempt: number): void => {
      const onError = (err: NodeJS.ErrnoException) => {
        // 旧プロセスの自動再起動と競合した場合に備え、EADDRINUSE はリトライする
        if (err.code === 'EADDRINUSE' && attempt < 45) {
          setTimeout(() => tryListen(attempt + 1), 2000);
          return;
        }
        console.error(`[Web] Could not listen on port ${this.port}:`, err);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, () => {
        this.server.removeListener('error', onError);
        this.debugLog(`WebServer listening on :${this.port} envPath=${this.envPath} cwd=${process.cwd()} execPath=${process.argv[1]}`);
        console.log('\n======================================================');
        console.log(`🌐 Web Dashboard is running at: http://localhost:${this.port}`);
        console.log('======================================================\n');
        this.startSelfCheck();
        this.startMaintenance();
      });
    };
    tryListen(0);
  }

  /**
   * 自己診断ウォッチドッグ。
   * JSONボディ付きPOSTのパースがハングする「wedged」状態を検出したら、
   * 新しい node プロセスを起こして自分は終了する（Launcher終了後も自動復旧するため）。
   */
  private startSelfCheck(): void {
    if (this.selfCheckTimer) return;
    this.selfCheckTimer = setInterval(() => { void this.runSelfCheck(); }, 15000);
    this.selfCheckTimer.unref?.();
  }

  /**
   * 生TCPでHTTPリクエストを書き込む自己診断プローブ。
   * fetch/undici はブラウザや curl と異なるヘッダー形状を送るため、
   * 「ブラウザからはハングするが監視は成功する」見逃しが起きた。
   * 最も忠実な再現のため、ソケットへ直接HTTPリクエスト文字列を書く。
   */
  private async probeHttpPost(): Promise<boolean> {
    const net = await import('net');
    return new Promise(resolve => {
      const body = '{}';
      const request =
        `POST /api/ping HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${this.port}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n` +
        body;
      const socket = net.connect(this.port, '127.0.0.1');
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { }
        resolve(ok);
      };
      socket.setTimeout(8000);
      socket.once('connect', () => socket.write(request));
      socket.once('data', (chunk: Buffer) => {
        const head = chunk.toString('latin1');
        done(/^HTTP\/1\.[01] 2\d\d/.test(head));
      });
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.once('close', () => done(false));
    });
  }

  private async runSelfCheck(): Promise<void> {
    let ok = false;
    try {
      ok = await this.probeHttpPost();
    } catch {
      ok = false;
    }
    if (!ok) {
      this.selfCheckFailures += 1;
      this.debugLog(`Self-check POST probe failed (streak=${this.selfCheckFailures})`);
    } else {
      if (this.selfCheckFailures > 0) this.debugLog('Self-check POST probe recovered.');
      this.selfCheckFailures = 0;
    }
    // 2回連続失敗（約30秒）で wedged と判断
    if (this.selfCheckFailures >= 2) {
      this.debugLog('Self-check failed: request body parsing appears wedged. Attempting automatic restart...');
      this.attemptSelfRestart();
    }
  }

  /**
   * 定期メンテナンス: %TEMP% 内の古い CraftMate 関連一時ファイルを削除し、
   * イベントループの遅延（同期的な重い処理によるブロック）を監視する。
   */
  private startMaintenance(): void {
    void this.cleanupTempFiles();
    this.tempCleanupTimer = setInterval(() => { void this.cleanupTempFiles(); }, 6 * 60 * 60 * 1000);
    this.tempCleanupTimer.unref?.();

    // アイドル自動終了: ダッシュボード（ブラウザ）の接続が90秒間ゼロで、
    // AIタスク実行中でもなくMinecraftボットも未接続なら、サーバー自身を終了する。
    // これによりブラウザだけ閉じた場合に node.exe がゾンビ化するのを防ぐ。
    // ボット接続中・タスク実行中は終了しない（自律動作を継続させるため）。
    this.idleShutdownTimer = setInterval(() => {
      try {
        if (this.connectedSockets > 0) return;
        const idleMs = Date.now() - this.lastSocketActivityAt;
        if (idleMs < 90 * 1000) return;
        if (this.agent.isBusy()) return;
        if (this.botWrapper.isConnected) return;
        this.debugLog(`Idle shutdown: no dashboard connections for ${Math.round(idleMs / 1000)}s, agent idle and bot offline. Exiting.`);
        process.exit(0);
      } catch (error) {
        this.debugLog(`Idle shutdown check failed: ${(error as Error).message}`);
      }
    }, 30000);
    this.idleShutdownTimer.unref?.();

    let lastTick = Date.now();
    this.loopLagTimer = setInterval(() => {
      const now = Date.now();
      const lag = now - lastTick - 1000;
      lastTick = now;
      if (lag > 2000) {
        this.loopLagCount += 1;
        this.debugLog(`Event loop lag detected: ${lag}ms (streak=${this.loopLagCount})`);
        // イベントループが数秒単位でブロックされるとリクエストボディが
        // 届かず BODY_TIMEOUT になる。連続する場合は自己診断の失敗としてカウントし、
        // 既存ウォッチドッグの自動再起動に繋げる。
        this.selfCheckFailures += 1;
      } else {
        this.loopLagCount = 0;
      }
    }, 1000);
    this.loopLagTimer.unref?.();
  }

  /**
   * %TEMP% 内の古い CraftMate 関連一時ファイルを削除する。
   * リリース作業フォルダ (CraftMate-release-*)、Updater の作業/ワーカーフォルダ
   * (CraftMateUpdate-*, CraftMateUpdater-*)、Setup の一時コピーを対象に、
   * 24時間以上前のものだけを削除する（実行中のワーカーはロックで失敗→スキップ）。
   */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const tempDir = os.tmpdir();
      const maxAgeMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      let entries: string[];
      try {
        entries = await fs.promises.readdir(tempDir);
      } catch { return; }

      let removed = 0;
      for (const name of entries) {
        const isTarget = name.startsWith('CraftMate-release-')
          || name.startsWith('CraftMateUpdate-')
          || name.startsWith('CraftMateUpdater-')
          || /^CraftMate_Setup_.*\.exe$/i.test(name)
          || /^craftmate[_-].*\.tmp$/i.test(name);
        if (!isTarget) continue;
        const fullPath = path.join(tempDir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (now - stat.mtimeMs < maxAgeMs) continue;
          if (stat.isDirectory()) {
            await fs.promises.rm(fullPath, { recursive: true, force: true, maxRetries: 2 });
          } else {
            await fs.promises.unlink(fullPath);
          }
          removed += 1;
        } catch { /* 使用中・権限不足はスキップ */ }
      }
      if (removed > 0) this.debugLog(`Temp cleanup removed ${removed} stale CraftMate item(s) from ${tempDir}`);
    } catch (error) {
      this.debugLog(`Temp cleanup failed: ${(error as Error).message}`);
    }
  }

  private attemptSelfRestart(): void {
    const now = Date.now();
    // 無限再起動ループ防止: 5分以内の再起動は1回まで
    if (now - this.lastSelfRestartAt < 5 * 60 * 1000) return;
    this.lastSelfRestartAt = now;
    this.selfCheckFailures = 0;

    // Launcher は相対パス "dist\index.js" で起動するため絶対パスに解決する
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    if (!entry || !fs.existsSync(entry)) return;
    try {
      const logPath = path.join(os.tmpdir(), 'CraftMate_server.log');
      const logFd = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [entry], {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      child.once('error', error => {
        console.error('[Web] Self-restart spawn failed:', error);
        this.debugLog(`Self-restart spawn failed: ${error.message}`);
      });
      child.unref();
      fs.closeSync(logFd);
      this.debugLog(`Restarting dashboard server (new PID ${child.pid}). Log: ${logPath}`);
      console.error(`[Web] Restarting dashboard server (new PID ${child.pid}). Log: ${logPath}`);
      setTimeout(() => process.exit(0), 800);
    } catch (error) {
      console.error('[Web] Self-restart failed:', error);
      this.debugLog(`Self-restart failed: ${(error as Error).message}`);
    }
  }

  public stop(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.selfCheckTimer) clearInterval(this.selfCheckTimer);
    if (this.tempCleanupTimer) clearInterval(this.tempCleanupTimer);
    if (this.loopLagTimer) clearInterval(this.loopLagTimer);
    if (this.idleShutdownTimer) clearInterval(this.idleShutdownTimer);
    this.io.close();
  }
}
