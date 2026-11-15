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

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = textInput ? textInput.value.trim() : '';
      if (!text || selectedRating < 1) return;
      fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: selectedRating,
          name: nameInput ? nameInput.value.trim() : '',
          comment: text
        })
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (bodyText) {
            var detail = '';
            try { detail = JSON.parse(bodyText).error || bodyText.slice(0, 200); } catch (e) { detail = bodyText.slice(0, 200); }
            throw new Error('HTTP ' + res.status + (detail ? ' - ' + detail : ''));
          });
        }
        return res.json();
      }).then(function () {
        textInput.value = '';
        if (nameInput) nameInput.value = '';
        selectedRating = 0;
        updateStarButtons();
        loadReviews();
      }).catch(function (error) {
        alert('レビューの投稿に失敗しました: ' + (error && error.message ? error.message : error));
      });
    });
  }

  loadReviews();
})();
