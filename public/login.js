// CraftMate ログイン画面
// 「Googleでログイン」等のボタン1つで OAuth 認証を開始する。
// Client ID/Secret はビルド時に .env へ埋め込まれた値が使われるため、
// 通常ユーザーは入力不要。未設定の場合のみ「上級者向け」フォームを表示する。
// 認証完了は /api/auth/status のポーリングで検知し、ダッシュボードへ遷移する。

(function () {
  const providersEl = document.getElementById('providers');
  const statusEl = document.getElementById('status');

  const PROVIDER_META = {
    google: { icon: '🔵', label: 'Google でログイン', setupHint: 'Google Cloud Console でOAuthクライアントを登録する必要があります。' },
    microsoft: { icon: '🟦', label: 'Microsoft でログイン', setupHint: 'Microsoft Entra ID（Azure Portal）でアプリケーションを登録する必要があります。' },
    github: { icon: '🐙', label: 'GitHub でログイン', setupHint: 'GitHub Developer Settings で OAuth App を登録する必要があります。' },
    discord: { icon: '💬', label: 'Discord でログイン', setupHint: 'Discord Developer Portal でアプリケーションを登録する必要があります。' },
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
