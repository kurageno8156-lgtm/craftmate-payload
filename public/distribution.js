// CraftMate 配布ページ: プラットフォーム自動判別 + お問い合わせ（FormSubmit）
// ユーザーレビューは GitHub Issues ベースの Utterances ウィジェットで公開
// （distribution.html に埋め込み。全世界が閲覧可能、投稿は GitHub ログイン）。
(function () {
  'use strict';

  // ---- OS 自動判別: ユーザーの環境に合ったカードをハイライト ----
  (function detectPlatform() {
    var ua = (navigator.userAgent || '').toLowerCase();
    var platform = (navigator.platform || '').toLowerCase();
    var detected = null;
    if (/android/.test(ua)) detected = 'android';
    else if (/iphone|ipad|ipod/.test(ua) || (/mac/.test(platform) && navigator.maxTouchPoints > 1)) detected = 'ios';
    else if (/mac/.test(platform) || /mac os x|macintosh/.test(ua)) detected = 'macos';
    else if (/linux/.test(platform) || (/linux/.test(ua) && !/android/.test(ua))) detected = 'linux';
    else if (/win/.test(platform) || /windows/.test(ua)) detected = 'windows';

    var cards = document.querySelectorAll('.platform-card');
    cards.forEach(function (card) {
      if (detected && card.getAttribute('data-os') === detected) {
        card.classList.add('recommended');
        var badge = card.querySelector('.badge');
        if (badge && detected !== 'windows') {
          badge.textContent = 'あなたのOS（近日公開）';
        } else if (badge && detected === 'windows') {
          badge.textContent = 'あなたのOS・利用可能';
        }
      }
    });
    var note = document.getElementById('platform-detect-note');
    if (note && detected) {
      var names = { windows: 'Windows', linux: 'Linux', macos: 'macOS', android: 'Android', ios: 'iOS' };
      note.textContent = 'あなたのOSは ' + (names[detected] || detected) + ' と判定されました。' +
        (detected === 'windows' ? '今すぐダウンロードできます。' : 'このOS版は近日公開予定です。Windows版は今すぐ利用できます。');
    }
  })();

  // ---- お問い合わせフォーム（FormSubmit → kurageno8156@gmail.com 固定）----
  var FORMSUBMIT_ENDPOINT = 'https://formsubmit.co/ajax/kurageno8156@gmail.com';

  function postViaFormSubmit(fields) {
    return fetch(FORMSUBMIT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(Object.assign({ _subject: 'CraftMate', _template: 'table' }, fields))
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.success !== 'true') {
          var msg = (data && data.message) || 'HTTP ' + res.status;
          if (/activation/i.test(msg)) {
            var err = new Error(msg);
            err.code = 'FORMSUBMIT_NEEDS_ACTIVATION';
            throw err;
          }
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function activationHint() {
    return 'フォーム送信には初回アクティベーションが必要です。kurageno8156@gmail.com に届いた「Activate Form」メールのリンクをクリックしてください。';
  }

  function showFormStatus(el, text, ok) {
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#4ade80' : '#f87171';
  }

  var contactForm = document.getElementById('contact-form');
  if (contactForm) {
    var contactStatus = document.getElementById('contact-status');
    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = (document.getElementById('contact-name') || {}).value || '';
      var message = (document.getElementById('contact-message') || {}).value || '';
      if (!message.trim()) return;
      var submitBtn = contactForm.querySelector('.review-submit');
      if (submitBtn) submitBtn.disabled = true;
      showFormStatus(contactStatus, '送信中…', true);
      postViaFormSubmit({
        _subject: 'CraftMate お問い合わせ - ' + (name.trim() || '匿名'),
        name: name.trim() || '（未入力）',
        message: message.trim()
      }).then(function () {
        if (submitBtn) submitBtn.disabled = false;
        contactForm.reset();
        showFormStatus(contactStatus, '送信しました。ご連絡ありがとうございます！', true);
      }).catch(function (error) {
        if (submitBtn) submitBtn.disabled = false;
        showFormStatus(contactStatus, (error && error.code === 'FORMSUBMIT_NEEDS_ACTIVATION' ? activationHint() : '送信に失敗しました: ' + (error && error.message ? error.message : error)), false);
      });
    });
  }

  // ---- 公開レビュー一覧（GitHub Issues API・閲覧専用）----
  // これまでの Utterances / GitHub Issue に投稿されたレビューを
  // API 経由で取得して一覧表示する。投稿フォームは設けない。
  (function initPublicReviews() {
    var listEl = document.getElementById('review-list-public');
    var statusEl = document.getElementById('review-public-status');
    if (!listEl) return;
    var REPO = 'kurageno8156-lgtm/craftmate-payload';
    var API = 'https://api.github.com/repos/' + REPO;
    var headers = { 'Accept': 'application/vnd.github+json' };

    function setStatus(text, ok) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.style.color = ok === false ? '#f87171' : '#a1a1aa';
    }

    function renderEmpty(text) {
      listEl.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'review-empty';
      p.textContent = text;
      listEl.appendChild(p);
    }

    function fmtDate(ts) {
      try { return new Date(ts).toLocaleDateString('ja-JP'); } catch (e) { return ''; }
    }

    function renderComments(comments) {
      listEl.innerHTML = '';
      if (!comments || !comments.length) {
        renderEmpty('まだレビューはありません。GitHub の Issue から感想を投稿できます。');
        return;
      }
      // 新しい順に表示
      comments.slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); }).forEach(function (c) {
        var card = document.createElement('article');
        card.className = 'review-card';
        var head = document.createElement('div');
        head.className = 'review-card-head';
        var author = document.createElement('span');
        author.className = 'review-meta';
        author.textContent = '@' + ((c.user && c.user.login) || 'unknown') + ' ・ ' + fmtDate(c.created_at);
        var link = document.createElement('a');
        link.className = 'review-meta';
        link.href = c.html_url || '#';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'GitHub ↗';
        head.appendChild(author);
        head.appendChild(link);
        var body = document.createElement('p');
        body.className = 'review-card-body';
        body.textContent = (c.body || '').slice(0, 2000);
        card.appendChild(head);
        card.appendChild(body);
        listEl.appendChild(card);
      });
    }

    setStatus('レビューを読み込み中…');
    fetch(API + '/issues?state=all&per_page=50', { headers: headers })
      .then(function (res) {
        if (res.status === 403) throw new Error('rate-limit');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (issues) {
        if (!Array.isArray(issues)) throw new Error('bad response');
        // Utterances が作成したレビュー用 Issue を探す（タイトルに CraftMate を含む Issue）
        var issue = issues
          .filter(function (i) { return !i.pull_request && /craftmate/i.test(i.title || ''); })
          .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })[0];
        if (!issue) { setStatus(''); renderEmpty('まだレビューはありません。'); return null; }
        return fetch(API + '/issues/' + issue.number + '/comments?per_page=100', { headers: headers })
          .then(function (r) { return r.ok ? r.json() : []; });
      })
      .then(function (comments) {
        if (comments === null) return;
        setStatus('');
        renderComments(Array.isArray(comments) ? comments : []);
      })
      .catch(function (e) {
        setStatus('レビューの読み込みに失敗しました' + (e && e.message === 'rate-limit' ? '（GitHub API のレート制限。しばらくして再読み込みしてください）' : '。'), false);
        renderEmpty('レビューを読み込めませんでした。');
      });
  })();

  // ---- 「CraftMate 検索結果」セクション ----
  // Google Custom Search（CSE）の cx が URL パラメータ ?cse_cx=... で指定された場合は
  // 公式の検索結果ウィジェットを埋め込む。未指定の場合は、主要な検索リンクと
  // 公式情報（GitHub / リリース / 配布ページ）をカード形式で表示する。
  (function initSearchResults() {
    var fallback = document.getElementById('search-results-fallback');
    var cseContainer = document.getElementById('cse-container');
    if (!fallback && !cseContainer) return;

    var params = new URLSearchParams(window.location.search);
    var cx = params.get('cse_cx') || window.CRAFTMATE_CSE_CX || '';

    if (cx && cseContainer) {
      cseContainer.hidden = false;
      var script = document.createElement('script');
      script.src = 'https://cse.google.com/cse.js?cx=' + encodeURIComponent(cx);
      script.onload = function () {
        if (window.google && window.google.search) {
          window.google.search.cse.element.render({
            div: 'cse-container',
            results: 'cse-container',
            tag: 'search-results-fallback'
          });
        }
      };
      document.head.appendChild(script);
      return;
    }

    var cards = [
      {
        title: 'CraftMate — GitHub リポジトリ',
        url: 'https://github.com/kurageno8156-lgtm/craftmate-payload',
        desc: 'ソースコード・Issue・リリース情報。CraftMate の公式リポジトリです。'
      },
      {
        title: 'Releases — 最新版ダウンロード',
        url: 'https://github.com/kurageno8156-lgtm/craftmate-payload/releases/latest',
        desc: 'Windows / Linux / macOS 向けの最新インストーラーとポータブル版。'
      },
      {
        title: '配布ページ（このページ）',
        url: 'distribution.html',
        desc: 'CraftMate の機能紹介・使い方・ユーザーレビュー。'
      }
    ];

    if (fallback) {
      cards.forEach(function (c) {
        var a = document.createElement('a');
        a.className = 'search-result-card';
        a.href = c.url;
        a.target = '_blank';
        a.rel = 'noopener';
        var t = document.createElement('div');
        t.className = 'search-result-title';
        t.textContent = c.title;
        var u = document.createElement('div');
        u.className = 'search-result-url';
        u.textContent = c.url;
        var d = document.createElement('div');
        d.className = 'search-result-desc';
        d.textContent = c.desc;
        a.appendChild(t); a.appendChild(u); a.appendChild(d);
        fallback.appendChild(a);
      });
      var note = document.createElement('p');
      note.className = 'search-results-note';
      note.textContent = '※ Google 検索結果の直接埋め込みには Custom Search API キーが必要です。上の検索リンクから各検索エンジンで「CraftMate」を検索できます。';
      fallback.appendChild(note);
    }

    var form = document.getElementById('craftmate-search');
    var input = document.getElementById('craftmate-search-input');
    if (form && input) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = (input.value || 'CraftMate').trim() || 'CraftMate';
        window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank', 'noopener');
      });
    }
  })();
})();
