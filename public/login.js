// CraftMate ログイン画面
// OAuth プロバイダ一覧を取得し、認証フローを開始する。
// 認証完了は /api/auth/status のポーリングで検知し、ダッシュボードへ遷移する。

(function () {
  const providersEl = document.getElementById('providers');
  const statusEl = document.getElementById('status');
  const skipBtn = document.getElementById('btn-skip');

  const PROVIDER_META = {
    google: { icon: '🔵', label: 'Google でログイン' },
    microsoft: { icon: '🟦', label: 'Microsoft でログイン' },
    github: { icon: '🐙', label: 'GitHub でログイン' },
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
    btn.addEventListener('click', () => {
      const form = wrap.querySelector('.provider-form');
      if (form) { form.classList.toggle('open'); return; }
      wrap.appendChild(buildCredentialForm(p));
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function buildCredentialForm(p) {
    const meta = PROVIDER_META[p.id] || { label: p.label || p.id };
    const form = document.createElement('div');
    form.className = 'provider-form open';

    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.placeholder = 'Client ID（.env 設定済みなら省略可）';
    idInput.autocomplete = 'off';

    const secretInput = document.createElement('input');
    secretInput.type = 'password';
    secretInput.placeholder = 'Client Secret（省略可）';
    secretInput.autocomplete = 'off';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.textContent = meta.label + ' →';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cancel';
    cancel.textContent = 'キャンセル';
    cancel.addEventListener('click', () => form.remove());

    go.addEventListener('click', async () => {
      go.disabled = true;
      setStatus('認証ページを開いています…');
      try {
        const res = await fetch('/api/auth/login/' + encodeURIComponent(p.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: idInput.value.trim() || undefined,
            clientSecret: secretInput.value.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'login failed');
        if (data.authUrl) {
          window.open(data.authUrl, '_blank');
          setStatus('ブラウザで認証を完了してください…（自動で遷移します）');
          pollForSession();
        }
      } catch (e) {
        setStatus(e.message || 'ログイン開始に失敗しました', 'error');
        go.disabled = false;
      }
    });

    actions.appendChild(go);
    actions.appendChild(cancel);
    form.appendChild(idInput);
    form.appendChild(secretInput);
    form.appendChild(actions);
    return form;
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

  skipBtn.addEventListener('click', async () => {
    skipBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error('skip failed');
      window.location.replace('/');
    } catch {
      setStatus('スキップに失敗しました', 'error');
      skipBtn.disabled = false;
    }
  });

  loadProviders();
})();
