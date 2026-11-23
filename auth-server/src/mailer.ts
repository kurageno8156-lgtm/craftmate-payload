import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// ---- メール送信の抽象化 ----
// 実プロバイダ（Resend/SES/SMTP等）は MAIL_PROVIDER 設定で差し替える。
// 既定は 'mock': 実際には送信せず data/mail-outbox.jsonl に記録する（開発/テスト用）。
// メール本文にトークン等の秘密情報をログへ出さない方針は変えない
// （outbox はローカルファイル・gitignore 対象。テストでは内容を検証に使う）。

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
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

// 実プロバイダ実装はここに追加する（例: Resend/Mailgun/SES/SMTP）。
// interface Mailer を満たすクラスを作り、config.mail.provider で選択する。
let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (!mailer) {
    switch (config.mail.provider) {
      case 'mock':
      default:
        mailer = new MockMailer();
        break;
      // case 'resend': mailer = new ResendMailer(); break;  // 将来実装
    }
  }
  return mailer;
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
