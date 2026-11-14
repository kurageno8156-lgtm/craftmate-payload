// CraftMate 配布ページ: ユーザーレビュー（サーバー SQLite 共有）
(function () {
  'use strict';

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
        if (!res.ok) throw new Error('post failed');
        textInput.value = '';
        if (nameInput) nameInput.value = '';
        selectedRating = 0;
        updateStarButtons();
        loadReviews();
      }).catch(function () {
        alert('レビューの投稿に失敗しました。もう一度お試しください。');
      });
    });
  }

  loadReviews();
})();
