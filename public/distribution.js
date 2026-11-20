// CraftMate 配布ページ: プラットフォーム自動判別 + ユーザーレビュー（サーバー SQLite 共有）
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

  var form = document.getElementById('review-form');
  var listEl = document.getElementById('review-list');
  var summaryEl = document.getElementById('review-summary');
  var nameInput = document.getElementById('review-name');
  var textInput = document.getElementById('review-text');
  var starButtons = Array.prototype.slice.call(document.querySelectorAll('#star-input .star'));
  var selectedRating = 0;

  function starsHtml(rating) {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<span class="review-star' + (i <= rating ? ' on' : '') + '">★</span>';
    }
    return html;
  }

  function formatDate(ts) {
    try { return new Date(ts).toLocaleDateString('ja-JP'); } catch (e) { return ''; }
  }

  function renderReviews(data) {
    if (!listEl) return;
    var reviews = (data && data.reviews) || [];
    listEl.innerHTML = '';

    if (reviews.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'review-empty';
      empty.textContent = 'まだレビューはありません。最初のレビューを投稿してみましょう。';
      listEl.appendChild(empty);
      if (summaryEl) summaryEl.textContent = 'CraftMate を使った感想を投稿できます。';
      return;
    }

    if (summaryEl && typeof data.average === 'number') {
      summaryEl.textContent = '平均評価 ' + data.average + ' / 5（' + (data.count || reviews.length) + '件のレビュー）';
    }

    reviews.forEach(function (review) {
      var card = document.createElement('article');
      card.className = 'review-card';
      var head = document.createElement('div');
      head.className = 'review-card-head';
      var stars = document.createElement('span');
      stars.className = 'review-stars';
      stars.innerHTML = starsHtml(review.rating);
      var meta = document.createElement('span');
      meta.className = 'review-meta';
      meta.textContent = (review.name || '匿名') + ' ・ ' + formatDate(review.created_at);
      head.appendChild(stars);
      head.appendChild(meta);
      var body = document.createElement('p');
      body.className = 'review-card-body';
      body.textContent = review.comment || '';
      card.appendChild(head);
      card.appendChild(body);
      listEl.appendChild(card);
    });
  }

  function loadReviews() {
    fetch('/api/reviews')
      .then(function (res) { return res.ok ? res.json() : { reviews: [], average: 0, count: 0 }; })
      .then(renderReviews)
      .catch(function () { renderReviews({ reviews: [] }); });
  }

  function updateStarButtons() {
    starButtons.forEach(function (btn) {
      var value = parseInt(btn.getAttribute('data-value'), 10);
      btn.classList.toggle('on', value <= selectedRating);
    });
  }

  starButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedRating = parseInt(btn.getAttribute('data-value'), 10);
      updateStarButtons();
    });
  });

  // 静的ホスティング（GitHub Pages 等）では /api/reviews が使えないため、
  // FormSubmit の AJAX エンドポイント経由でメール送信する（要アクティベーション：
  // 初回送信時に kurageno8156@gmail.com 宛へ確認メールが届きます）。
  var FORMSUBMIT_ENDPOINT = 'https://formsubmit.co/ajax/kurageno8156@gmail.com';

  function postViaFormSubmit(fields) {
    return fetch(FORMSUBMIT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(Object.assign({ _subject: 'CraftMate', _template: 'table' }, fields))
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.success !== 'true') throw new Error((data && data.message) || 'HTTP ' + res.status);
        return data;
      });
    });
  }

  function showFormStatus(el, text, ok) {
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#4ade80' : '#f87171';
  }

  if (form) {
    var reviewStatus = document.getElementById('review-status');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = textInput ? textInput.value.trim() : '';
      var name = nameInput ? nameInput.value.trim() : '';
      if (!text || selectedRating < 1) return;
      var rating = selectedRating;
      var submitBtn = form.querySelector('.review-submit');
      if (submitBtn) submitBtn.disabled = true;
      showFormStatus(reviewStatus, '送信中…', true);

      // 1) アプリ内サーバー経由（SQLite保存）を試行
      fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: rating, name: name, comment: text })
      }).then(function (res) {
        if (res.ok) return res.json().then(function () { return 'api'; });
        // 静的ホスティング（405 等）→ FormSubmit へフォールバック
        var ct = res.headers.get('content-type') || '';
        if (res.status === 405 || res.status === 404 || ct.indexOf('text/html') >= 0) {
          return postViaFormSubmit({
            _subject: 'CraftMate レビュー（' + rating + '/5）',
            rating: rating + '/5', name: name || '匿名', comment: text
          }).then(function () { return 'formsubmit'; });
        }
        return res.text().then(function (bodyText) {
          var detail = '';
          try { detail = JSON.parse(bodyText).error || bodyText.slice(0, 200); } catch (e2) { detail = bodyText.slice(0, 200); }
          throw new Error('HTTP ' + res.status + (detail ? ' - ' + detail : ''));
        });
      }).then(function (mode) {
        if (submitBtn) submitBtn.disabled = false;
        textInput.value = '';
        if (nameInput) nameInput.value = '';
        selectedRating = 0;
        updateStarButtons();
        if (mode === 'api') { loadReviews(); showFormStatus(reviewStatus, 'レビューを投稿しました！', true); }
        else showFormStatus(reviewStatus, 'レビューを送信しました。ありがとうございます！', true);
      }).catch(function (error) {
        if (submitBtn) submitBtn.disabled = false;
        showFormStatus(reviewStatus, '投稿に失敗しました: ' + (error && error.message ? error.message : error), false);
      });
    });
  }

  // ---- お問い合わせフォーム ----
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
        showFormStatus(contactStatus, '送信に失敗しました: ' + (error && error.message ? error.message : error), false);
      });
    });
  }

  loadReviews();

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
        desc: 'Windows / Linux 向けの最新インストーラーとポータブル版。'
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
