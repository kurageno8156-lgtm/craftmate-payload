// CraftMate ログイン画面
// 「Googleでログイン」等のボタン1つで OAuth 認証を開始する。
// Client ID/Secret はビルド時に .env へ埋め込まれた値が使われるため、
// 通常ユーザーは入力不要。未設定の場合のみ「上級者向け」フォームを表示する。
// 認証完了は /api/auth/status のポーリングで検知し、ダッシュボードへ遷移する。

(function () {
  const providersEl = document.getElementById('providers');
  const statusEl = document.getElementById('status');

  // OAuthクライアント未設定時の共通案内。
  // 配布物に Client Secret は同梱されないため、ユーザー自身が設定ファイルを配置する必要がある。
  const OAUTH_SETUP_FILE = '%LOCALAPPDATA%\\CraftMate\\oauth-clients.json';
  const OAUTH_SETUP_HINT = 'Client ID/Secret を ' + OAUTH_SETUP_FILE + ' に設定してください（雛形: oauth-clients.example.json）。';

  const PROVIDER_META = {
    google: { icon: '🔵', label: 'Google でログイン', setupHint: 'Google Cloud Console でOAuthクライアントを登録し、' + OAUTH_SETUP_HINT },
    github: { icon: '🐙', label: 'GitHub でログイン', setupHint: 'GitHub Developer Settings で OAuth App を登録し、' + OAUTH_SETUP_HINT },
    discord: { icon: '💬', label: 'Discord でログイン', setupHint: 'Discord Developer Portal でアプリケーションを登録し、' + OAUTH_SETUP_HINT },
  };

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      const data = await res.json();
      return !!(data && data.authenticated);
    } catch {
      return false;
    }
  }

  // 既にログイン済みならダッシュボードへ
  checkSession().then((authed) => {
    if (authed) window.location.replace('/');
  });

  async function loadProviders() {
    let platforms = [];
    try {
      const res = await fetch('/api/integrations', { cache: 'no-store' });
      const data = await res.json();
      platforms = (data.platforms || []).filter((p) => PROVIDER_META[p.id]);
    } catch { /* fall through to defaults */ }
    if (!platforms.length) {
      platforms = Object.keys(PROVIDER_META).map((id) => ({ id, label: PROVIDER_META[id].label }));
    }
    providersEl.textContent = '';
    for (const p of platforms) {
      providersEl.appendChild(buildProviderBlock(p));
    }
  }

  function buildProviderBlock(p) {
    const meta = PROVIDER_META[p.id] || { icon: '🔐', label: p.label || p.id, setupHint: 'OAuthクライアントの設定が必要です。' };
    const wrap = document.createElement('div');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-btn';
    const statusBadge = document.createElement('span');
    if (p.oauthConfigured === true) {
      statusBadge.className = 'provider-badge ok';
      statusBadge.textContent = '設定済み';
    } else if (p.oauthConfigured === false) {
      statusBadge.className = 'provider-badge off';
      statusBadge.textContent = '未設定';
    }
    btn.innerHTML = '<span class="icon">' + meta.icon + '</span><span>' + meta.label + '</span>';
    if (statusBadge.textContent) btn.appendChild(statusBadge);
    btn.addEventListener('click', () => startLogin(p, btn, wrap, meta));
    wrap.appendChild(btn);
    return wrap;
  }

  async function startLogin(p, btn, wrap, meta) {
    btn.disabled = true;
    setStatus('認証ページを開いています…');
    try {
      const res = await fetch('/api/auth/login/' + encodeURIComponent(p.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && data.code === 'CLIENT_ID_REQUIRED') {
        // OAuth クライアントが未設定のプロバイダは利用不可（プロバイダ別の日本語案内）
        const hint = (meta && meta.setupHint) || '管理者がOAuthクライアントを設定する必要があります。';
        setStatus(`${p.label || p.id} のOAuthが設定されていません。${hint}`, 'error');
        btn.disabled = false;
        return;
      }
      if (!res.ok) throw new Error(data.error || 'login failed');
      if (data.authUrl) {
        window.open(data.authUrl, '_blank');
        setStatus('ブラウザで認証を完了してください…（自動で遷移します）');
        pollForSession();
      }
    } catch (e) {
      setStatus(e.message || 'ログイン開始に失敗しました', 'error');
      btn.disabled = false;
    }
  }

  // ---- 内部アカウント（OAuth フォールバック）----
  const localForm = document.getElementById('local-form');
  const localUserInput = document.getElementById('local-username');
  const localPassInput = document.getElementById('local-password');
  const localLoginBtn = document.getElementById('local-login-btn');
  const localRegisterBtn = document.getElementById('local-register-btn');

  async function localAuth(endpoint) {
    const username = (localUserInput.value || '').trim();
    const password = localPassInput.value || '';
    if (!username || !password) { setStatus('ユーザー名とパスワードを入力してください。', 'error'); return; }
    localLoginBtn.disabled = true;
    localRegisterBtn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '認証に失敗しました');
      setStatus('ログインしました。ダッシュボードを開きます…', 'ok');
      setTimeout(() => window.location.replace('/'), 400);
    } catch (e) {
      setStatus(e.message || '認証に失敗しました', 'error');
      localLoginBtn.disabled = false;
      localRegisterBtn.disabled = false;
    }
  }

  if (localForm) {
    localForm.addEventListener('submit', (e) => { e.preventDefault(); localAuth('/api/auth/local-login'); });
    localRegisterBtn.addEventListener('click', () => localAuth('/api/auth/register'));
  }

  // ---- クラウドアカウント（Auth Server 連携）----
  const cloudForm = document.getElementById('cloud-form');
  const cloudEmailInput = document.getElementById('cloud-email');
  const cloudPassInput = document.getElementById('cloud-password');
  const cloudLoginBtn = document.getElementById('cloud-login-btn');
  const cloudRegisterBtn = document.getElementById('cloud-register-btn');
  const cloudHint = document.getElementById('cloud-hint');

  // サーバー側でクラウド認証が設定されているか確認し、フォームを表示する
  async function initCloudForm() {
    if (!cloudForm) return;
    try {
      const res = await fetch('/api/cloud/status', { cache: 'no-store' });
      const data = await res.json();
      if (data && data.configured) {
        cloudForm.style.display = 'grid';
        if (data.loggedIn && data.email) {
          cloudHint.textContent = 'クラウドアカウントでログイン中: ' + data.email;
        }
      }
    } catch { /* cloud auth unavailable */ }
  }

  async function cloudAuth(endpoint) {
    const email = (cloudEmailInput.value || '').trim();
    const password = cloudPassInput.value || '';
    if (!email || !password) { setStatus('メールアドレスとパスワードを入力してください。', 'error'); return; }
    cloudLoginBtn.disabled = true;
    cloudRegisterBtn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '認証に失敗しました');
      setStatus('ログインしました。ダッシュボードを開きます…', 'ok');
      setTimeout(() => window.location.replace('/'), 400);
    } catch (e) {
      setStatus(e.message || '認証に失敗しました', 'error');
      cloudLoginBtn.disabled = false;
      cloudRegisterBtn.disabled = false;
    }
  }

  if (cloudForm) {
    cloudForm.addEventListener('submit', (e) => { e.preventDefault(); cloudAuth('/api/cloud/login'); });
    cloudRegisterBtn.addEventListener('click', () => cloudAuth('/api/cloud/register'));
    initCloudForm();
  }

  // ---- パスワードリセット・メール確認再送 ----
  const resetPanel = document.getElementById('cloud-reset-panel');
  const forgotBtn = document.getElementById('cloud-forgot-btn');
  const verifyBtn = document.getElementById('cloud-verify-btn');
  const resetConfirmBtn = document.getElementById('reset-confirm-btn');

  if (forgotBtn && resetPanel) {
    forgotBtn.addEventListener('click', async () => {
      const email = (cloudEmailInput?.value || '').trim();
      if (!email) { setStatus('メールアドレスを入力してください。', 'error'); return; }
      forgotBtn.disabled = true;
      try {
        const res = await fetch('/api/cloud/password/reset/request', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '送信に失敗しました');
        setStatus(data.message || 'リセットメールを送信しました。', 'ok');
        resetPanel.style.display = 'block';
      } catch (e) {
        setStatus(e.message || '送信に失敗しました', 'error');
      } finally { forgotBtn.disabled = false; }
    });
  }
  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      const email = (cloudEmailInput?.value || '').trim();
      if (!email) { setStatus('メールアドレスを入力してください。', 'error'); return; }
      verifyBtn.disabled = true;
      try {
        const res = await fetch('/api/cloud/email/verify/request', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '送信に失敗しました');
        setStatus(data.message || '確認メールを送信しました。', 'ok');
      } catch (e) {
        setStatus(e.message || '送信に失敗しました', 'error');
      } finally { verifyBtn.disabled = false; }
    });
  }
  if (resetConfirmBtn) {
    resetConfirmBtn.addEventListener('click', async () => {
      const token = (document.getElementById('reset-token')?.value || '').trim();
      const newPass = document.getElementById('reset-newpass')?.value || '';
      if (!token || !newPass) { setStatus('トークンと新しいパスワードを入力してください。', 'error'); return; }
      resetConfirmBtn.disabled = true;
      try {
        const res = await fetch('/api/cloud/password/reset/confirm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword: newPass }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '変更に失敗しました');
        setStatus(data.message || 'パスワードを変更しました。', 'ok');
        resetPanel.style.display = 'none';
      } catch (e) {
        setStatus(e.message || '変更に失敗しました', 'error');
      } finally { resetConfirmBtn.disabled = false; }
    });
  }

  // OAuth は外部ブラウザで完了するため、セッション確立をポーリングで検知する
  async function pollForSession() {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await checkSession()) {
        setStatus('ログインしました。ダッシュボードを開きます…', 'ok');
        setTimeout(() => window.location.replace('/'), 600);
        return;
      }
    }
    setStatus('タイムアウトしました。もう一度お試しください。', 'error');
  }

  loadProviders();
})();
