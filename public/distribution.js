// CraftMate 配布ページ: ユーザーレビュー（localStorage 保存）
(function () {
  'use strict';

  var STORAGE_KEY = 'craftmate.distributionReviews.v1';
  var MAX_REVIEWS = 100;

  var form = document.getElementById('review-form');
  var listEl = document.getElementById('review-list');
  var summaryEl = document.getElementById('review-summary');
  var nameInput = document.getElementById('review-name');
  var textInput = document.getElementById('review-text');
  var starButtons = Array.prototype.slice.call(document.querySelectorAll('#star-input .star'));
  var selectedRating = 0;

  function loadReviews() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(saved)) return saved;
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveReviews(reviews) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews.slice(0, MAX_REVIEWS)));
    } catch (e) { /* ignore */ }
  }

  function starsHtml(rating) {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<span class="review-star' + (i <= rating ? ' on' : '') + '">★</span>';
    }
    return html;
  }

  function renderReviews() {
    if (!listEl) return;
    var reviews = loadReviews();
    listEl.innerHTML = '';

    if (reviews.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'review-empty';
      empty.textContent = 'まだレビューはありません。最初のレビューを投稿してみましょう。';
      listEl.appendChild(empty);
    } else {
      var total = reviews.reduce(function (sum, r) { return sum + (r.rating || 0); }, 0);
      var avg = (total / reviews.length).toFixed(1);
      if (summaryEl) {
        summaryEl.textContent = '平均評価 ' + avg + ' / 5（' + reviews.length + '件のレビュー）';
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
        meta.textContent = (review.name || '匿名') + ' ・ ' + (review.date || '');
        head.appendChild(stars);
        head.appendChild(meta);
        var body = document.createElement('p');
        body.className = 'review-card-body';
        body.textContent = review.text || '';
        card.appendChild(head);
        card.appendChild(body);
        listEl.appendChild(card);
      });
    }
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
      var reviews = loadReviews();
      reviews.unshift({
        name: nameInput && nameInput.value.trim() ? nameInput.value.trim() : '匿名',
        rating: selectedRating,
        text: text,
        date: new Date().toLocaleDateString('ja-JP')
      });
      saveReviews(reviews);
      textInput.value = '';
      if (nameInput) nameInput.value = '';
      selectedRating = 0;
      updateStarButtons();
      renderReviews();
    });
  }

  renderReviews();
})();
