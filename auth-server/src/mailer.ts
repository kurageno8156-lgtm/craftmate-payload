import fs from 'node:fs';
import path from 'node:path';
import { Resend } from 'resend';
import { config } from './config.js';

// ---- メール送信の抽象化 ----
// MAIL_PROVIDER でプロバイダを選択:
//   'mock'   : 実際には送信せず data/mail-outbox.jsonl に記録（開発/テスト専用）
//   'resend' : Resend API 経由で実メール送信（本番用）
// メール本文にトークン等の秘密情報をログへ出さない方針は変えない
// （outbox はローカルファイル・gitignore 対象。テストでは内容を検証に使う）。

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

class MockMailer implements Mailer {
  private outboxPath: string;
  constructor() {
    this.outboxPath = path.join(config.db.dataDir, 'mail-outbox.jsonl');
    fs.mkdirSync(config.db.dataDir, { recursive: true });
  }
  async send(msg: MailMessage): Promise<void> {
    // 開発用: 送信内容をローカルファイルに追記（実メールは送らない）
    const line = JSON.stringify({ ts: new Date().toISOString(), to: msg.to, subject: msg.subject, text: msg.text });
    fs.appendFileSync(this.outboxPath, line + '\n', { mode: 0o600 });
  }
}

// Resend SDK クライアントの最小インターフェース（テストでモック差し替え可能）
export interface ResendLike {
  emails: {
    send(payload: {
      from: string;
      to: string | string[];
      subject: string;
      text?: string;
      html?: string;
      reply_to?: string | string[];
    }, options?: { signal?: AbortSignal }): Promise<{ data: unknown; error: { message?: string; name?: string } | null }>;
  };
}

// Resend API 呼び出しのタイムアウト。無応答時にリクエストハンドラを
// 無期限に占有しないよう 10 秒で打ち切る（AbortSignal.timeout）。
const RESEND_TIMEOUT_MS = 10_000;

export class ResendMailer implements Mailer {
  private client: ResendLike;
  private from: string;
  private replyTo?: string;

  constructor(client?: ResendLike) {
    this.client = client ?? (new Resend(config.mail.resendApiKey) as unknown as ResendLike);
    this.from = config.mail.from;
    this.replyTo = config.mail.replyTo || undefined;
  }

  async send(msg: MailMessage): Promise<void> {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      reply_to: this.replyTo,
    }, { signal: AbortSignal.timeout(RESEND_TIMEOUT_MS) });
    if (error) {
      // Resend のエラーオブジェクトに APIキーは含まれないが、
      // 念のためメッセージのみを使用し request 情報は転記しない。
      throw new Error(`Resend send failed: ${error.name || 'error'}: ${error.message || 'unknown'}`.slice(0, 300));
    }
    if (!data) {
      throw new Error('Resend send failed: empty response');
    }
  }
}

let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (!mailer) {
    switch (config.mail.provider) {
      case 'resend':
        mailer = new ResendMailer();
        break;
      case 'mock':
      default:
        mailer = new MockMailer();
        break;
    }
  }
  return mailer;
}

// テスト用: mailer シングルトンをリセット
export function resetMailerForTest(): void {
  mailer = null;
}

// テスト用: outbox の内容を読む（モックのみ有効）
export function readMailOutbox(): MailMessage[] {
  try {
    const p = path.join(config.db.dataDir, 'mail-outbox.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as MailMessage[];
  } catch { return []; }
}
