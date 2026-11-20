// CraftMate ログイン画面
// 「Googleでログイン」等のボタン1つで OAuth 認証を開始する。
// Client ID/Secret はビルド時に .env へ埋め込まれた値が使われるため、
// 通常ユーザーは入力不要。未設定の場合のみ「上級者向け」フォームを表示する。
// 認証完了は /api/auth/status のポーリングで検知し、ダッシュボードへ遷移する。

(function () {
  const providersEl = document.getElementById('providers');
  const statusEl = document.getElementById('status');

  const PROVIDER_META = {
    google: { icon: '🔵', label: 'Google でログイン' },
    microsoft: { icon: '🟦', label: 'Microsoft でログイン' },
    github: { icon: '🐙', label: 'GitHub でログイン' },
    discord: { icon: '💬', label: 'Discord でログイン' },
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
    const meta = PROVIDER_META[p.id] || { icon: '🔐', label: p.label || p.id };
    const wrap = document.createElement('div');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-btn';
    btn.innerHTML = '<span class="icon">' + meta.icon + '</span><span>' + meta.label + '</span>';
    btn.addEventListener('click', () => startLogin(p, btn, wrap));
    wrap.appendChild(btn);
    return wrap;
  }

  async function startLogin(p, btn, wrap) {
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
        // OAuth クライアントが埋め込まれていないプロバイダは利用不可
        setStatus('このログイン方法は現在利用できません。', 'error');
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
