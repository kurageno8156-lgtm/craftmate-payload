// BlockWhiz 配布ページ: プラットフォーム自動判別 + お問い合わせ（FormSubmit）
// ユーザーレビューは GitHub Discussions に誘導する（distribution.html のリンクのみ。
// サイト側で投稿内容を収集・改変しない設計）。
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
      body: JSON.stringify(Object.assign({ _subject: 'BlockWhiz', _template: 'table' }, fields))
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
        _subject: 'BlockWhiz お問い合わせ - ' + (name.trim() || '匿名'),
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

  // ---- レビュー機能 ----
  // レビュー投稿・閲覧は GitHub Discussions 側で行う（distribution.html のリンク）。
  // サイト側では投稿フォーム・外部サービスを持たない。

  // ---- 最新バージョン表示（アプリ内蔵サーバー経由でのみ取得可能）----
  (function initVersionBadge() {
    var note = document.getElementById('latest-version-note');
    var el = document.getElementById('latest-version');
    if (!note || !el) return;
    fetch('api/version', { headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.version) {
          el.textContent = 'v' + data.version;
          note.hidden = false;
        }
      })
      .catch(function () { /* 静的ホスティングでは非表示のまま */ });
  })();

  // ---- 「BlockWhiz 検索結果」セクション ----
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
        title: 'BlockWhiz — GitHub リポジトリ',
        url: 'https://github.com/kurageno8156-lgtm/blockwhiz',
        desc: 'ソースコード・Issue・リリース情報。BlockWhiz の公式リポジトリです。'
      },
      {
        title: 'Releases — 最新版ダウンロード',
        url: 'https://github.com/kurageno8156-lgtm/blockwhiz/releases/latest',
        desc: 'Windows / Linux / macOS 向けの最新インストーラーとポータブル版。'
      },
      {
        title: '配布ページ（このページ）',
        url: 'distribution.html',
        desc: 'BlockWhiz の機能紹介・使い方・ユーザーレビュー。'
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
      note.textContent = '※ Google 検索結果の直接埋め込みには Custom Search API キーが必要です。上の検索リンクから各検索エンジンで「BlockWhiz」を検索できます。';
      fallback.appendChild(note);
    }

    var form = document.getElementById('craftmate-search');
    var input = document.getElementById('craftmate-search-input');
    if (form && input) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = (input.value || 'BlockWhiz').trim() || 'BlockWhiz';
        window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank', 'noopener');
      });
    }
  })();
})();
