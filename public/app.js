const socket = io();

// ---- グローバルエラーハンドリング：クリック後のサイレントエラーを可視化 ----
window.addEventListener('error', (event) => {
  console.error('[UI] Uncaught error:', event.error || event.message);
  if (typeof appendLog === 'function') {
    appendLog({ status: 'error', timestamp: new Date().toLocaleTimeString(), thought: 'UIエラー: ' + (event.message || 'unknown') });
  }
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[UI] Unhandled promise rejection:', event.reason);
});
socket.on('connect_error', (err) => {
  console.error('[UI] Socket.IO connection error:', err);
});

// 要素が存在しない場合でもスクリプト全体が落ちないようにするヘルパー
function on(element, event, handler) {
  if (element && typeof element.addEventListener === 'function') {
    element.addEventListener(event, handler);
  }
}

const translate = (key, values) => (window.craftMateI18n ? window.craftMateI18n.t(key, values) : key);
let mcNameDb = { items: {}, entities: {}, biomes: {} };
fetch('/minecraft-names.json')
  .then(res => res.json())
  .then(data => {
    if (data) {
      mcNameDb = data;
      if (lastRenderedStatus) renderStatus(lastRenderedStatus);
    }
  })
  .catch(err => console.warn('Could not load minecraft-names.json:', err));
let lastRenderedStatus = null;
function updateLlmLabel(provider, model) {
  if (llmInfo) llmInfo.textContent = translate('aiBrain', { provider: String(provider || '').toUpperCase(), model: model || '' });
}

document.addEventListener('craftmate-language-changed', () => {
  if (!llmInfo) return;
  const match = llmInfo.textContent.match(/(?:AI Brain|AI 脳):\s*([^ (]+)\s*\((.*)\)$/);
  if (match) updateLlmLabel(match[1], match[2]);
  if (lastRenderedStatus) renderStatus(lastRenderedStatus);
});

// DOM要素
const connStatus = document.getElementById('connection-status');
const llmInfo = document.getElementById('llm-info');
const hpBar = document.getElementById('hp-bar');
const hpVal = document.getElementById('hp-val');
const foodBar = document.getElementById('food-bar');
const foodVal = document.getElementById('food-val');
const posVal = document.getElementById('pos-val');
const dimVal = document.getElementById('dimension-val');
const biomeVal = document.getElementById('biome-val');
const timeVal = document.getElementById('time-val');
const heldVal = document.getElementById('held-val');

const armorHelmet = document.getElementById('armor-helmet');
const armorChest = document.getElementById('armor-chest');
const armorLegs = document.getElementById('armor-legs');
const armorBoots = document.getElementById('armor-boots');

const invCount = document.getElementById('inv-count');
const invContainer = document.getElementById('inventory-container');
const inventoryModal = document.getElementById('inventory-modal');
const inventoryModalContainer = document.getElementById('inventory-modal-container');
const showAllInventoryButton = document.getElementById('btn-show-all-inventory');
const entitiesContainer = document.getElementById('entities-container');

const screenShareToggle = document.getElementById('screen-share-toggle');
const botScreenModal = document.getElementById('bot-screen-modal');
const botScreenView = document.getElementById('bot-screen-view');
const closeBotScreen = document.getElementById('close-bot-screen');

if (screenShareToggle) {
  on(screenShareToggle, 'change', (e) => {
    if (e.target.checked) {
      socket.emit('start-screen-share');
      fetchWithLocalSettingsAuth('/api/launch-screen-viewer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then(async response => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          console.warn('Could not launch the screen viewer:', data.error || response.status);
          if (typeof showSettingsMessage === 'function') {
            showSettingsMessage(data.error || 'Could not launch the screen viewer.', 'error');
          }
        }
      }).catch(error => {
        console.warn('Could not launch the screen viewer:', error);
        if (typeof showSettingsMessage === 'function') {
          showSettingsMessage(String(error && error.message ? error.message : error), 'error');
        }
      });
    } else {
      socket.emit('stop-screen-share');
      if (botScreenModal) botScreenModal.hidden = true;
    }
  });
}

socket.on('bot-screen', (base64Image) => {
  if (botScreenView) botScreenView.src = 'data:image/jpeg;base64,' + base64Image;
});

function closeBotScreenModal() {
  if (botScreenModal) botScreenModal.hidden = true;
  if (screenShareToggle) screenShareToggle.checked = false;
  socket.emit('stop-screen-share');
}

if (closeBotScreen) {
  on(closeBotScreen, 'click', closeBotScreenModal);
}
if (botScreenModal) {
  on(botScreenModal.querySelector('[data-close-bot-screen]'), 'click', closeBotScreenModal);
}

const taskText = document.getElementById('current-task-text');
const btnCancel = document.getElementById('btn-cancel');
const logsContainer = document.getElementById('logs-container');
const commandForm = document.getElementById('command-form');
const commandInput = document.getElementById('command-input');

// 初期設定・ステータス読み込み
fetch('/api/status')
  .then(res => res.json())
  .then(data => {
    updateConnectionUI(data.connected);
    if (data.config) {
      updateLlmLabel(data.config.provider, data.config.model);
    }
    if (data.status) {
      renderStatus(data.status);
    }
  })
  .catch(err => console.error('Initial fetch failed:', err));

// Socket.io イベント受信
socket.on('connect', () => {
  console.log('Connected to Dashboard server');
});

socket.on('status', (status) => {
  if (status && Object.prototype.hasOwnProperty.call(status, 'status')) {
    updateConnectionUI(status.connected);
    renderStatus(status.status);
  } else {
    updateConnectionUI(true);
    renderStatus(status);
  }
});

socket.on('disconnect', () => {
  updateConnectionUI(false);
  // アップデート中はサーバーが再起動されるため、オーバーレイの文言を更新する
  const overlayText = document.getElementById('update-overlay-text');
  if (overlayText && overlayText.dataset.phase === 'updating') {
    overlayText.textContent = translate('serverRestarting');
    overlayText.dataset.phase = 'restarting';
  }
});

socket.on('taskStarted', (data) => {
  if (taskText) taskText.textContent = translate('taskFrom', { requester: data.requester, task: data.task });
  if (btnCancel) btnCancel.style.display = 'block';
  appendLog({
    status: 'acting',
    timestamp: new Date().toLocaleTimeString(),
    thought: translate('newTask', { task: data.task, requester: data.requester }),
  });
});

socket.on('taskFinished', (data) => {
  if (taskText) taskText.textContent = translate('emptyTask');
  if (btnCancel) btnCancel.style.display = 'none';
});

socket.on('agentLog', (log) => {
  appendLog(log);
});

socket.on('chatMessage', (chat) => {
  appendLog({
    status: 'system',
    timestamp: chat.timestamp,
    thought: `💬 <${chat.sender}> ${chat.text}`,
  });
  appendRoomMessage('mc', `<${chat.sender}> ${chat.text}`);
});

socket.on('aiChatMessage', (data) => {
  if (data && data.text) appendRoomMessage('ai', data.text);
});

// UI更新関数
function updateConnectionUI(connected) {
  if (!connStatus) return;
  const dot = connStatus.querySelector('.dot');
  const text = connStatus.querySelector('.text');
  if (!dot || !text) return;
  if (connected) {
    dot.className = 'dot online';
    text.textContent = translate('online');
  } else {
    dot.className = 'dot offline';
    text.textContent = translate('offline');
  }
}

function renderStatus(status) {
  if (!status) return;
  const requiredElements = [hpBar, hpVal, foodBar, foodVal, posVal, dimVal, biomeVal, timeVal, heldVal, armorHelmet, armorChest, armorLegs, armorBoots, invCount, invContainer, entitiesContainer, taskText, btnCancel, showAllInventoryButton, inventoryModal];
  if (requiredElements.some(el => !el)) return;
  lastRenderedStatus = status;

  // HP & Food
  hpVal.textContent = status.health;
  hpBar.style.width = `${Math.max(0, Math.min(100, (status.health / 20) * 100))}%`;

  foodVal.textContent = status.food;
  foodBar.style.width = `${Math.max(0, Math.min(100, (status.food / 20) * 100))}%`;

  // Info
  posVal.textContent = `X: ${status.position.x}, Y: ${status.position.y}, Z: ${status.position.z}`;
  const dimension = String(status.dimension || '');
  dimVal.textContent = ({ overworld: translate('overworld'), nether: translate('nether'), the_nether: translate('nether'), end: translate('theEnd'), the_end: translate('theEnd') })[dimension.toLowerCase()] || dimension;
  biomeVal.textContent = getLocalizedBiomeName(status.biome);
  const gameTime = String(status.gameTime || '');
  timeVal.textContent = /day|昼/i.test(gameTime) ? translate('daytime') : /night|夜/i.test(gameTime) ? translate('nighttime') : gameTime;
  const formatEquipName = raw => {
    if (!raw || raw === '-') return '-';
    if (raw === '素手') return translate('bareHands');
    return getLocalizedItemName({ name: raw });
  };
  heldVal.textContent = !status.heldItem || status.heldItem === '素手' ? translate('bareHands') : formatEquipName(status.heldItem);

  // Armor
  armorHelmet.innerHTML = `🪖 <span>${formatEquipName(status.equippedArmor?.helmet)}</span>`;
  armorChest.innerHTML = `🦺 <span>${formatEquipName(status.equippedArmor?.chestplate)}</span>`;
  armorLegs.innerHTML = `👖 <span>${formatEquipName(status.equippedArmor?.leggings)}</span>`;
  armorBoots.innerHTML = `👢 <span>${formatEquipName(status.equippedArmor?.boots)}</span>`;

  // Always replace both grids, including when the server sends missing or empty arrays.
  const inventory = Array.isArray(status.inventory) ? status.inventory.filter(item => item && Number(item.count) > 0) : [];
  const entityList = Array.isArray(status.nearbyEntities) ? status.nearbyEntities.filter(entity => entity && entity.name) : [];
  invCount.textContent = inventory.length;
  showAllInventoryButton.hidden = inventory.length <= 8;
  showAllInventoryButton.textContent = translate('showAllItems', { count: inventory.length });
  renderInventoryCards(inventory.slice(0, 8), invContainer);
  if (!inventoryModal.hidden) renderInventoryCards(inventory, inventoryModalContainer);

  entitiesContainer.replaceChildren();
  if (entityList.length === 0) {
    entitiesContainer.appendChild(createGridEmptyState(translate('noEntities')));
  } else {
    entityList.forEach(entity => {
      const card = document.createElement('div');
      card.className = `entity-item${entity.isHostile ? ' hostile' : ''}${entity.isPlayer ? ' player' : ''}`;
      const icon = document.createElement('span');
      icon.className = 'entity-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = getEntityIcon(entity);
      const copy = document.createElement('span');
      copy.className = 'entity-copy';
      const type = document.createElement('span');
      type.className = 'entity-type';
      type.textContent = translate(`entityCategory_${entity.category || 'other'}`);
      const name = document.createElement('span');
      name.className = 'entity-name';
      name.textContent = getLocalizedEntityName(entity);
      copy.append(type, name);
      const distance = document.createElement('span');
      distance.className = 'entity-distance';
      distance.textContent = `${Number(entity.distance || 0)}m`;
      card.append(icon, copy, distance);
      entitiesContainer.appendChild(card);
    });
  }

  // Task Status
  if (status.currentTask) {
    taskText.textContent = translate('activeTask', { task: status.currentTask });
    btnCancel.style.display = 'block';
  } else if (!status.isExecuting) {
    taskText.textContent = translate('emptyTask');
    btnCancel.style.display = 'none';
  }
}

function renderInventoryCards(items, container) {
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(createGridEmptyState(translate('emptyInventory')));
    return;
  }
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'inv-item';
    card.title = String(item.displayName || item.name || '');
    const icon = document.createElement('span');
    icon.className = 'inv-item-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = getItemIcon(item.name);
    const name = document.createElement('span');
    name.className = 'inv-item-name';
    name.textContent = getLocalizedItemName(item);
    const count = document.createElement('span');
    count.className = 'inv-count';
    count.textContent = `×${Number(item.count) || 0}`;
    card.append(icon, name, count);
    container.appendChild(card);
  });
}

function getMinecraftDataName(category, rawKey) {
  if (!rawKey) return null;
  const key = String(rawKey).toLowerCase().trim().replace(/^minecraft:/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const lang = window.craftMateI18n?.language === 'ja' ? 'ja' : 'en';
  const entry = mcNameDb && mcNameDb[category] ? mcNameDb[category][key] : null;
  if (entry && entry[lang]) return entry[lang];
  if (entry && entry.en) return entry.en;
  return null;
}

function getLocalizedBiomeName(biome) {
  if (!biome || biome === 'unknown' || biome === 'offline') {
    return biome || 'unknown';
  }
  const fromDb = getMinecraftDataName('biomes', biome);
  if (fromDb) return fromDb;
  const rawKey = String(biome).toLowerCase().trim().replace(/^minecraft:/, '').replace(/[^a-z0-9]+/g, '_');
  const translated = translate(`biome_${rawKey}`);
  return translated === `biome_${rawKey}` ? biome : translated;
}

function getLocalizedItemName(item) {
  const rawName = String(item.name || '').toLowerCase().replace(/^minecraft:/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const fromDb = getMinecraftDataName('items', rawName);
  if (fromDb) return fromDb;
  const translated = translate(`itemName_${rawName}`);
  if (translated !== `itemName_${rawName}`) return translated;
  return String(item.displayName || item.name || translate('unknownItem'));
}

function getItemIcon(name) {
  const item = String(name || '').toLowerCase();
  if (/pickaxe|axe|sword|shovel|hoe|bow|shield|crossbow|trident/.test(item)) return '⚒️';
  if (/bread|beef|pork|chicken|mutton|rabbit|potato|carrot|apple|fish|stew|food/.test(item)) return '🍖';
  if (/log|wood|plank|stick|sapling/.test(item)) return '🪵';
  if (/stone|cobble|deepslate|dirt|sand|gravel|ore/.test(item)) return '🪨';
  if (/torch|lantern|glowstone/.test(item)) return '🔦';
  if (/armor|helmet|chestplate|leggings|boots/.test(item)) return '🛡️';
  if (/diamond|emerald|gold|iron|ingot|coal|gem/.test(item)) return '💎';
  return '📦';
}

function getEntityIcon(entity) {
  if (entity.category === 'player') return '👤';
  if (entity.category === 'item') return getItemIcon(entity.name);
  if (entity.category === 'hostile') return '👾';
  const name = String(entity.name || '').toLowerCase();
  if (/cow|mooshroom/.test(name)) return '🐄';
  if (/pig/.test(name)) return '🐖';
  if (/sheep/.test(name)) return '🐑';
  if (/chicken/.test(name)) return '🐔';
  if (/horse|donkey|mule/.test(name)) return '🐴';
  if (/wolf|dog/.test(name)) return '🐺';
  if (/cat|ocelot/.test(name)) return '🐈';
  if (/villager/.test(name)) return '🧑';
  return '🐾';
}

function getLocalizedEntityName(entity) {
  if (entity.customName) return String(entity.customName);
  const rawName = String(entity.name || '').toLowerCase().replace(/^minecraft:/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (entity.category === 'item') {
    const fromDb = getMinecraftDataName('items', rawName);
    if (fromDb) return fromDb;
    const translated = translate(`itemName_${rawName}`);
    if (translated !== `itemName_${rawName}`) return translated;
  } else {
    const fromDb = getMinecraftDataName('entities', rawName);
    if (fromDb) return fromDb;
    const translated = translate(`entityName_${rawName}`);
    if (translated !== `entityName_${rawName}`) return translated;
  }
  return String(entity.displayName || entity.name || translate('unknownEntity'));
}

on(showAllInventoryButton, 'click', () => {
  if (!lastRenderedStatus || !inventoryModal) return;
  const inventory = Array.isArray(lastRenderedStatus.inventory) ? lastRenderedStatus.inventory.filter(item => item && Number(item.count) > 0) : [];
  renderInventoryCards(inventory, inventoryModalContainer);
  inventoryModal.hidden = false;
  inventoryModal.querySelector('.inventory-modal-close')?.focus();
});

if (inventoryModal) {
  inventoryModal.querySelectorAll('[data-close-inventory]').forEach(button => {
    button.addEventListener('click', () => {
      inventoryModal.hidden = true;
      if (showAllInventoryButton) showAllInventoryButton.focus();
    });
  });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && inventoryModal && !inventoryModal.hidden) {
    inventoryModal.hidden = true;
    if (showAllInventoryButton) showAllInventoryButton.focus();
  }
});

function createGridEmptyState(message) {
  const empty = document.createElement('div');
  empty.className = 'empty-hint';
  empty.setAttribute('role', 'status');
  empty.textContent = message;
  return empty;
}

function buildLogEntry(log) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${log.status || 'acting'}`;

  let html = `<div class="log-meta">
    <span>${translate('logStep', { step: log.stepNumber || 0, status: translate(`status${String(log.status || 'unknown').replace(/(^|_)([a-z])/g, (_, __, letter) => letter.toUpperCase())}`) })}</span>
    <span>${log.timestamp || new Date().toLocaleTimeString()}</span>
  </div>`;

  if (log.thought) {
    html += `<div class="log-thought">💭 ${escapeHtml(log.thought)}</div>`;
  }
  if (log.actionName) {
    const paramsStr = log.actionParams ? JSON.stringify(log.actionParams) : '';
    html += `<div class="log-action">${translate('logAction', { action: escapeHtml(log.actionName), params: escapeHtml(paramsStr) })}</div>`;
  }
  if (log.observation) {
    html += `<div class="log-obs">${translate('logObservation', { text: escapeHtml(log.observation) })}</div>`;
  }

  entry.innerHTML = html;
  return entry;
}

function appendLog(log) {
  if (!logsContainer) return;
  logsContainer.appendChild(buildLogEntry(log));
  logsContainer.scrollTop = logsContainer.scrollHeight;
  // ルームごとのログとして保存（activeRoomId は後述のチャットルーム初期化で定義）
  if (typeof activeRoomId !== 'undefined' && activeRoomId && typeof logsForRoom === 'function') {
    const arr = logsForRoom(activeRoomId);
    arr.push(log);
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    saveRoomLogs();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}

// ---- チャットルーム（サーバー SQLite 永続化 + ルーム別AIログ）----
const chatRoomList = document.getElementById('chat-room-list');
const chatMessages = document.getElementById('chat-messages');
const btnNewRoom = document.getElementById('btn-new-room');
const ROOM_LOGS_KEY = 'craftmate.roomLogs.v1';
const LEGACY_ROOMS_KEY = 'craftmate.chatRooms.v1';

let chatRooms = [];
let activeRoomId = null;
const roomMessagesCache = {};

function loadRoomLogs() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_LOGS_KEY));
    return saved && typeof saved === 'object' ? saved : {};
  } catch (e) { return {}; }
}
const roomLogs = loadRoomLogs();
function saveRoomLogs() {
  try { localStorage.setItem(ROOM_LOGS_KEY, JSON.stringify(roomLogs)); } catch (e) { /* ignore */ }
}
function logsForRoom(id) {
  return roomLogs[id] || (roomLogs[id] = []);
}

function uiError(context, error) {
  const message = error && error.message ? error.message : String(error);
  console.error('[UI] ' + context + ' failed:', error);
  if (typeof appendLog === 'function') {
    appendLog({ status: 'error', timestamp: new Date().toLocaleTimeString(), thought: context + ': ' + message });
  }
}

async function apiGet(p) {
  try {
    const r = await fetch(p, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status);
    return await r.json();
  } catch (e) { uiError('API GET ' + p, e); throw e; }
}
async function apiSend(method, p, body) {
  try {
    const r = await fetch(p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && data.error) || (method + ' ' + p + ' -> ' + r.status));
    return data;
  } catch (e) { uiError('API ' + method + ' ' + p, e); throw e; }
}

let roomsLoadError = false;

async function refreshRooms(selectId) {
  try {
    const data = await apiGet('/api/chat-rooms');
    chatRooms = data.rooms || [];
    roomsLoadError = false;
  } catch (e) {
    chatRooms = [];
    roomsLoadError = true;
  }
  if (selectId && chatRooms.find(r => r.id === selectId)) activeRoomId = selectId;
  else if (!chatRooms.find(r => r.id === activeRoomId)) activeRoomId = chatRooms.length ? chatRooms[0].id : null;
  renderChatRooms();
  if (activeRoomId) await loadRoom(activeRoomId);
  else { renderChatMessages(); renderActivityLog(); }
}

async function loadRoom(id) {
  try {
    const data = await apiGet('/api/chat-rooms/' + encodeURIComponent(id) + '/messages');
    roomMessagesCache[id] = data.messages || [];
  } catch (e) { roomMessagesCache[id] = []; }
  if (id === activeRoomId) {
    renderChatMessages();
    renderActivityLog();
  }
}

function renderChatRooms() {
  if (!chatRoomList) return;
  chatRoomList.innerHTML = '';
  if (roomsLoadError) {
    const err = document.createElement('div');
    err.className = 'chat-empty-hint';
    err.style.color = 'var(--accent-red)';
    err.textContent = translate('chatRoomsLoadFailed');
    chatRoomList.appendChild(err);
    return;
  }
  if (chatRooms.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'chat-empty-hint';
    hint.textContent = translate('chatEmptyHint');
    chatRoomList.appendChild(hint);
    return;
  }
  for (const room of chatRooms) {
    const item = document.createElement('div');
    item.className = 'chat-room-item' + (room.id === activeRoomId ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'chat-room-title';
    label.textContent = room.title || translate('newChatRoom');
    label.title = label.textContent;
    label.addEventListener('click', () => {
      activeRoomId = room.id;
      renderChatRooms();
      loadRoom(room.id);
    });
    const del = document.createElement('button');
    del.className = 'chat-room-delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = translate('deleteChatRoom');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await apiSend('DELETE', '/api/chat-rooms/' + encodeURIComponent(room.id)); }
      catch (err) { uiError('チャットルーム削除', err); return; }
      delete roomMessagesCache[room.id];
      await refreshRooms();
    });
    item.appendChild(label);
    item.appendChild(del);
    chatRoomList.appendChild(item);
  }
}

const SENDER_TO_ROLE = { user: 'user', ai: 'ai', minecraft: 'mc' };
const ROLE_TO_SENDER = { user: 'user', ai: 'ai', mc: 'minecraft' };

function renderChatMessages() {
  if (!chatMessages) return;
  chatMessages.innerHTML = '';
  const msgs = activeRoomId ? (roomMessagesCache[activeRoomId] || []) : [];
  if (msgs.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'chat-empty-hint';
    hint.textContent = translate('chatEmptyHint');
    chatMessages.appendChild(hint);
    return;
  }
  for (const msg of msgs) {
    const role = SENDER_TO_ROLE[msg.sender] || 'mc';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-' + role;
    const who = document.createElement('div');
    who.className = 'chat-bubble-who';
    who.textContent = role === 'user' ? translate('chatYou') : role === 'ai' ? 'CraftMate AI' : translate('chatMinecraft');
    const body = document.createElement('div');
    body.className = 'chat-bubble-text';
    body.textContent = msg.content;
    bubble.appendChild(who);
    bubble.appendChild(body);
    chatMessages.appendChild(bubble);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderActivityLog() {
  if (!logsContainer) return;
  logsContainer.innerHTML = '';
  const logs = activeRoomId ? logsForRoom(activeRoomId) : [];
  if (logs.length === 0) {
    const entry = document.createElement('div');
    entry.className = 'log-entry system';
    entry.innerHTML = '<span class="log-time">System</span><span class="log-text">' + escapeHtml(translate('systemReady')) + '</span>';
    logsContainer.appendChild(entry);
    return;
  }
  logs.forEach(l => logsContainer.appendChild(buildLogEntry(l)));
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

async function ensureActiveRoom() {
  if (activeRoomId && chatRooms.find(r => r.id === activeRoomId)) return activeRoomId;
  const data = await apiSend('POST', '/api/chat-rooms', {});
  await refreshRooms(data.room ? data.room.id : null);
  return activeRoomId;
}

function appendRoomMessage(role, text) {
  if (!text) return;
  // ユーザーの指示を「AIの思考・行動ログ」にも表示する
  if (role === 'user' && typeof appendLog === 'function') {
    appendLog({
      status: 'system',
      timestamp: new Date().toLocaleTimeString(),
      thought: '👤 ' + translate('chatYou') + ': ' + String(text),
    });
  }
  (async () => {
    try {
      const roomId = await ensureActiveRoom();
      if (!roomId) return;
      const sender = ROLE_TO_SENDER[role] || 'user';
      // 楽観的にキャッシュへ追加してからサーバーへ保存（一時的なハングに備えリトライ）
      (roomMessagesCache[roomId] = roomMessagesCache[roomId] || []).push({ sender, content: String(text), created_at: Date.now() });
      renderChatMessages();
      const payload = { sender, content: String(text) };
      const url = '/api/chat-rooms/' + encodeURIComponent(roomId) + '/messages';
      try {
        await apiSend('POST', url, payload);
      } catch (firstError) {
        await new Promise(r => setTimeout(r, 1200));
        await apiSend('POST', url, payload);
      }
      renderChatRooms(); // タイトルが更新された可能性があるため再描画
    } catch (e) { uiError('チャットメッセージ保存', e); }
  })();
}

// 旧 localStorage 形式のルームをサーバーへ一度だけ移行
(async function migrateLegacyRooms() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_ROOMS_KEY));
    if (!legacy || !Array.isArray(legacy.rooms) || legacy.rooms.length === 0) return;
    const existing = await apiGet('/api/chat-rooms');
    if ((existing.rooms || []).length > 0) { localStorage.removeItem(LEGACY_ROOMS_KEY); return; }
    for (const room of legacy.rooms) {
      const created = await apiSend('POST', '/api/chat-rooms', { id: room.id, title: room.title || '' });
      const rid = created.room ? created.room.id : room.id;
      for (const msg of (room.messages || [])) {
        await apiSend('POST', '/api/chat-rooms/' + encodeURIComponent(rid) + '/messages', {
          sender: ROLE_TO_SENDER[msg.role] || 'user',
          content: msg.text || '',
        });
      }
    }
    localStorage.removeItem(LEGACY_ROOMS_KEY);
  } catch (e) { /* 移行失敗は無視 */ }
})();

on(btnNewRoom, 'click', async () => {
  try {
    const data = await apiSend('POST', '/api/chat-rooms', {});
    await refreshRooms(data.room ? data.room.id : null);
  } catch (e) { uiError('チャットルーム作成', e); }
});
document.addEventListener('craftmate-language-changed', () => {
  renderChatRooms();
  renderChatMessages();
  renderActivityLog();
});
refreshRooms();

// フォーム送信
on(commandForm, 'submit', (e) => {
  try {
    e.preventDefault();
    if (!commandInput) return;
    const text = commandInput.value.trim();
    if (!text) return;

    appendRoomMessage('user', text);
    socket.emit('sendInstruction', { instruction: text, sender: 'WebDashboard' });
    commandInput.value = '';
  } catch (err) {
    uiError('指示送信', err);
  }
});

// タスク中断
on(btnCancel, 'click', () => {
  socket.emit('cancelTask');
});

// クイックコマンドボタン
// data-cmd は現在の言語に応じて i18n.js の apply() が data-cmd-ja / data-cmd-en から再設定する。
// 「ストップ」判定は表示言語に依存しないよう data-cmd-ja / data-cmd-en の両方で比較する。
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    try {
      const cmd = btn.getAttribute('data-cmd');
      if (!cmd) return;
      const isStop = ['ストップ', 'stop', '停止', '中止', 'ruko', 'rukou'].includes(cmd)
        || btn.getAttribute('data-cmd-ja') === 'ストップ'
        || btn.getAttribute('data-cmd-en') === 'Stop';
      if (isStop) {
        socket.emit('cancelTask');
      } else {
        appendRoomMessage('user', cmd);
        socket.emit('sendInstruction', { instruction: cmd, sender: 'WebDashboard' });
      }
    } catch (e) {
      uiError('クイックコマンド', e);
    }
  });
});

const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');
const settingsMessage = document.getElementById('settings-message');
const providerSelect = document.getElementById('setting-provider');
const modelSelect = document.getElementById('setting-model');
const minecraftVersionSelect = document.getElementById('setting-mc-version');
const minecraftVersionCustomInput = document.getElementById('setting-mc-version-custom');
const languageSelect = document.getElementById('setting-language');
const apiKeyInput = document.getElementById('setting-api-key');
if (languageSelect) {
  languageSelect.value = window.craftMateI18n.language;
  on(languageSelect, 'change', () => window.craftMateI18n.setLanguage(languageSelect.value));
}
const modelsByProvider = {
  gemini: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'],
  groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
  ollama: ['llama3.1', 'qwen3', 'deepseek-r1'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
};

function populateModelOptions(provider, selectedModel) {
  if (!modelSelect) return;
  const models = [...(modelsByProvider[provider] || modelsByProvider.gemini)];
  if (selectedModel && !models.includes(selectedModel)) models.unshift(selectedModel);
  modelSelect.replaceChildren(...models.map(model => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    return option;
  }));
  modelSelect.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0];
}

function showSettingsMessage(message, state) {
  if (!settingsMessage) return;
  settingsMessage.textContent = message || '';
  settingsMessage.className = `settings-message${state ? ` ${state}` : ''}`;
}

function updateCustomMinecraftVersionVisibility() {
  if (!minecraftVersionSelect || !minecraftVersionCustomInput) return;
  const isCustom = minecraftVersionSelect.value === 'custom';
  minecraftVersionCustomInput.hidden = !isCustom;
  minecraftVersionCustomInput.required = isCustom;
}

function setMinecraftVersionSetting(version) {
  if (!minecraftVersionSelect || !minecraftVersionCustomInput) return;
  const value = String(version || 'auto').trim() || 'auto';
  const hasOption = Array.from(minecraftVersionSelect.options).some(option => option.value === value && option.value !== 'custom');
  if (hasOption) {
    minecraftVersionSelect.value = value;
    minecraftVersionCustomInput.value = '';
  } else {
    minecraftVersionSelect.value = 'custom';
    minecraftVersionCustomInput.value = value;
  }
  updateCustomMinecraftVersionVisibility();
}

on(minecraftVersionSelect, 'change', updateCustomMinecraftVersionVisibility);

function setConnectionState(name, connected) {
  const dot = document.getElementById(`${name}-health-dot`);
  const label = document.getElementById(`${name}-health-label`);
  if (!dot || !label) return;
  dot.className = `connection-dot ${connected ? 'online' : 'offline'}`;
  label.textContent = connected ? translate('connected') : translate('disconnected');
  label.style.color = connected ? 'var(--accent-green)' : 'var(--accent-red)';
}

async function refreshHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(translate('healthCheckFailed'));
    const health = await response.json();
    setConnectionState('minecraft', health.minecraftConnected);
    setConnectionState('ai', health.aiConnected);
    const healthChecked = document.getElementById('health-checked');
    if (healthChecked) healthChecked.textContent = translate('checked', { time: new Date().toLocaleTimeString() });
  } catch {
    setConnectionState('minecraft', false);
    setConnectionState('ai', false);
    const healthChecked = document.getElementById('health-checked');
    if (healthChecked) healthChecked.textContent = translate('healthUnavailable');
  }
}

async function loadSettings() {
  try {
    const response = await fetch('/api/settings', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || translate('settingsLoadFailed'));
    document.getElementById('setting-mc-port').value = data.mcPort || 25565;
    setMinecraftVersionSetting(data.mcVersion || 'auto');
    document.getElementById('setting-username').value = data.username || 'AIMAN';
    document.getElementById('setting-web-port').value = data.webPort || 3000;
    providerSelect.value = data.provider || 'gemini';
    populateModelOptions(providerSelect.value, data.model);
    apiKeyInput.value = '';
    const adminMap = {
      'admin-allow-commands': data.botAllowCommands,
      'admin-allow-dangerous': data.botAllowDangerousCommands,
      'admin-allow-fileops': data.botAllowFileOps,
      'admin-allow-autoguard': data.botAllowAutoguard,
    };
    for (const [id, value] of Object.entries(adminMap)) {
      const el = document.getElementById(id);
      if (el) el.checked = value !== false;
    }
    document.getElementById('api-key-help').textContent = data.apiKeyConfigured
      ? translate('keySaved')
      : translate('noKeySaved');
    showSettingsMessage('', '');
    await refreshHealth();
  } catch (error) {
    showSettingsMessage(error.message || translate('settingsLoadFailed'), 'error');
  }
}

on(document.getElementById('btn-settings'), 'click', () => {
  if (settingsModal) settingsModal.hidden = false;
  document.getElementById('setting-mc-port')?.focus();
  loadSettings();
});
on(document.getElementById('btn-close-settings'), 'click', () => { if (settingsModal) settingsModal.hidden = true; });
if (settingsModal) {
  on(settingsModal.querySelector('[data-close-settings]'), 'click', () => { settingsModal.hidden = true; });
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && settingsModal && !settingsModal.hidden) settingsModal.hidden = true;
});
on(providerSelect, 'change', () => {
  populateModelOptions(providerSelect.value);
  const needsKey = providerSelect.value !== 'ollama';
  const keyHelp = document.getElementById('api-key-help');
  if (keyHelp) keyHelp.textContent = needsKey
    ? translate('keepKey')
    : translate('ollamaNoKey');
});

on(settingsForm, 'submit', async event => {
  event.preventDefault();
  const saveButton = document.getElementById('btn-save-settings');
  saveButton.disabled = true;
  showSettingsMessage(translate('saving'));
  const mcVersionValue = minecraftVersionSelect.value === 'custom'
    ? minecraftVersionCustomInput.value.trim()
    : minecraftVersionSelect.value;
  if (mcVersionValue && mcVersionValue !== 'auto') {
    const vparts = mcVersionValue.split('.').map(Number);
    const versionTooNew = vparts.some(n => Number.isNaN(n)) ||
      vparts[0] > 26 || (vparts[0] === 26 && (vparts[1] || 0) > 1) ||
      (vparts[0] === 26 && vparts[1] === 1 && (vparts[2] || 0) > 0);
    if (versionTooNew) {
      showSettingsMessage(translate('mcVersionTooNew'), 'error');
      saveButton.disabled = false;
      return;
    }
  }
  const payload = {
    mcPort: Number(document.getElementById('setting-mc-port').value),
    mcVersion: mcVersionValue,
    username: document.getElementById('setting-username').value.trim(),
    webPort: Number(document.getElementById('setting-web-port').value),
    provider: providerSelect.value,
    model: modelSelect.value,
    aiApiKey: apiKeyInput.value,
    botAllowCommands: document.getElementById('admin-allow-commands')?.checked !== false,
    botAllowDangerousCommands: document.getElementById('admin-allow-dangerous')?.checked !== false,
    botAllowFileOps: document.getElementById('admin-allow-fileops')?.checked !== false,
    botAllowAutoguard: document.getElementById('admin-allow-autoguard')?.checked !== false,
  };
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || translate('settingsSaveFailed'));
    apiKeyInput.value = '';
    showSettingsMessage(result.reconnecting ? translate('reconnecting') : translate('settingsSaved'), 'success');
    if (result.webPortChanged) {
      showSettingsMessage(translate('reopeningPort'), 'success');
      setTimeout(() => { window.location.href = `${window.location.protocol}//${window.location.hostname}:${result.webPort}`; }, 1200);
    }
    refreshHealth();
    fetch('/api/status').then(response => response.json()).then(data => {
    if (data.config) updateLlmLabel(data.config.provider, data.config.model);
    }).catch(() => {});
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      showSettingsMessage(translate('processingInBackground'), 'success');
    } else {
      showSettingsMessage(error.message || translate('settingsSaveFailed'), 'error');
    }
  } finally {
    saveButton.disabled = false;
  }
});

async function getLocalSettingsToken(refresh = false) {
  const meta = document.querySelector('meta[name="craftmate-update-token"]');
  let token = !refresh && meta ? meta.content : '';
  if (!token) {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(translate('updateAuthMissing'));
    const html = await response.text();
    const documentCopy = new DOMParser().parseFromString(html, 'text/html');
    token = documentCopy.querySelector('meta[name="craftmate-update-token"]')?.content || '';
    if (!token) throw new Error(translate('updateAuthMissing'));
    if (meta) meta.content = token;
  }
  return token;
}

async function fetchWithLocalSettingsAuth(url, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getLocalSettingsToken(attempt > 0);
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    try {
      const response = await fetch(url, { ...options, headers, cache: options.cache || 'no-store', signal: AbortSignal.timeout(10000) });
      if (response.status !== 403 || attempt > 0) return response;
    } catch (error) {
      // タイムアウト時はサーバー側で処理が続いている可能性があるため、ユーザーに伝える
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(translate('processingInBackground'));
      }
      throw error;
    }
  }
  throw new Error(translate('updateAuthMissing'));
}

on(document.getElementById('btn-create-backup'), 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetchWithLocalSettingsAuth('/api/backup');
    const backup = await response.json();
    if (!response.ok) throw new Error(backup.error || translate('backupFailed'));
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const fallbackName = `craftmate_backup_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
    link.download = /^craftmate_backup_\d{8}_\d{6}\.json$/.test(backup.fileName || '')
      ? backup.fileName
      : fallbackName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showSettingsMessage(translate('backupCreated', { fileName: link.download }), 'success');
  } catch (error) {
    showSettingsMessage(error.message || translate('backupFailed'), 'error');
  } finally {
    button.disabled = false;
  }
});

const backupFileInput = document.getElementById('settings-backup-file');
on(document.getElementById('btn-restore-backup'), 'click', () => backupFileInput?.click());
on(backupFileInput, 'change', async () => {
  const file = backupFileInput.files?.[0];
  backupFileInput.value = '';
  if (!file) return;
  const button = document.getElementById('btn-restore-backup');
  try {
    if (file.size > 256 * 1024) throw new Error(translate('invalidBackup'));
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch { throw new Error(translate('invalidBackup')); }
    if (!backup || backup.format !== 'craftmate-settings-backup' || backup.version !== 1 || typeof backup.env !== 'string') {
      throw new Error(translate('invalidBackup'));
    }
    if (!window.confirm(translate('restoreConfirm'))) return;
    button.disabled = true;
    showSettingsMessage(translate('restoringBackup'));
    const response = await fetchWithLocalSettingsAuth('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messageKey = result.code === 'INVALID_JSON' || result.code === 'INVALID_BACKUP_DATA'
        ? 'invalidBackup'
        : result.code === 'RESTORE_PERMISSION_DENIED'
          ? 'restorePermissionDenied'
          : result.code === 'RESTORE_WRITE_FAILED'
            ? 'restoreWriteFailed'
            : '';
      throw new Error(messageKey ? translate(messageKey) : result.error || translate('restoreFailed'));
    }
    showSettingsMessage(translate('restoreSuccess'), 'success');
    setTimeout(() => {
      if (result.webPortChanged) {
        const dashboardUrl = new URL(window.location.href);
        dashboardUrl.port = String(result.webPort);
        window.location.assign(dashboardUrl.toString());
      } else {
        window.location.reload();
      }
    }, 900);
  } catch (error) {
    showSettingsMessage(error.message || translate('restoreFailed'), 'error');
  } finally {
    button.disabled = false;
  }
});

on(document.getElementById('btn-reconnect'), 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/reconnect', { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(translate('reconnectFailed'));
    showSettingsMessage(translate('reconnectStarted'), 'success');
  } catch (error) {
    showSettingsMessage(error.message, 'error');
  } finally {
    button.disabled = false;
    refreshHealth();
  }
});

on(document.getElementById('btn-ai-restart'), 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/ai/restart', { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(translate('aiRestartFailed'));
    showSettingsMessage(translate('aiRestarted'), 'success');
    refreshHealth();
  } catch (error) {
    showSettingsMessage(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

on(document.getElementById('btn-check-updates'), 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  showSettingsMessage(translate('launchingUpdater'));
  try {
    const response = await fetchWithLocalSettingsAuth('/api/launch-updater', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || translate('updaterLaunchFailed'));
    showSettingsMessage(translate('updaterLaunched'), 'success');
    showUpdateOverlay('updating');
  } catch (error) {
    showSettingsMessage(error.message || translate('updaterLaunchFailed'), 'error');
  } finally {
    button.disabled = false;
  }
});

// アップデート中の全画面オーバーレイ（サーバー停止中も「更新中」と表示し続ける）
function showUpdateOverlay(phase) {
  let overlay = document.getElementById('update-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'update-overlay';
    overlay.className = 'update-overlay';
    overlay.innerHTML =
      '<div class="update-overlay-card">' +
      '<div class="update-spinner"></div>' +
      '<h2>' + escapeHtml(translate('updaterLaunched')) + '</h2>' +
      '<p id="update-overlay-text"></p>' +
      '</div>';
    document.body.appendChild(overlay);
  }
  const text = document.getElementById('update-overlay-text');
  if (text) {
    text.dataset.phase = phase;
    text.textContent = phase === 'updating' ? translate('updateInProgress') : translate('serverRestarting');
  }
}

on(document.getElementById('btn-download-logs'), 'click', () => {
  const lines = Array.from(logsContainer.querySelectorAll('.log-entry')).map(entry => entry.innerText.trim());
  const blob = new Blob([lines.join('\n\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `craftmate-logs-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);
});

refreshHealth();
setInterval(refreshHealth, 10000);
