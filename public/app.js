const socket = io();

const translate = (key, values) => window.craftMateI18n.t(key, values);
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
  llmInfo.textContent = translate('aiBrain', { provider: String(provider || '').toUpperCase(), model: model || '' });
}

document.addEventListener('craftmate-language-changed', () => {
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

screenShareToggle.addEventListener('change', (e) => {
  if (e.target.checked) {
    socket.emit('start-screen-share');
    botScreenModal.hidden = false;
  } else {
    socket.emit('stop-screen-share');
    botScreenModal.hidden = true;
  }
});

socket.on('bot-screen', (base64Image) => {
  botScreenView.src = 'data:image/jpeg;base64,' + base64Image;
});

closeBotScreen.addEventListener('click', () => {
  botScreenModal.hidden = true;
  screenShareToggle.checked = false;
  socket.emit('stop-screen-share');
});

const screenShareToggle = document.getElementById('screen-share-toggle');
const botScreenModal = document.getElementById('bot-screen-modal');
const botScreenView = document.getElementById('bot-screen-view');
const closeBotScreen = document.getElementById('close-bot-screen');

const screenShareToggle = document.getElementById('screen-share-toggle');
const botScreenModal = document.getElementById('bot-screen-modal');
const botScreenView = document.getElementById('bot-screen-view');
const closeBotScreen = document.getElementById('close-bot-screen');

const taskText = document.getElementById('current-task-text');

screenShareToggle.addEventListener('change', (e) => {
  if (e.target.checked) {
    socket.emit('start-screen-share');
    botScreenModal.style.display = 'block';
  } else {
    socket.emit('stop-screen-share');
    botScreenModal.style.display = 'none';
  }
});

socket.on('bot-screen', (base64Image) => {
  botScreenView.src = 'data:image/jpeg;base64,' + base64Image;
});

closeBotScreen.addEventListener('click', () => {
  botScreenModal.style.display = 'none';
  screenShareToggle.checked = false;
  socket.emit('stop-screen-share');
});
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
});

socket.on('taskStarted', (data) => {
  taskText.textContent = translate('taskFrom', { requester: data.requester, task: data.task });
  btnCancel.style.display = 'block';
  appendLog({
    status: 'acting',
    timestamp: new Date().toLocaleTimeString(),
    thought: translate('newTask', { task: data.task, requester: data.requester }),
  });
});

socket.on('taskFinished', (data) => {
  taskText.textContent = translate('emptyTask');
  btnCancel.style.display = 'none';
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
});

// UI更新関数
function updateConnectionUI(connected) {
  const dot = connStatus.querySelector('.dot');
  const text = connStatus.querySelector('.text');
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

showAllInventoryButton.addEventListener('click', () => {
  if (!lastRenderedStatus) return;
  const inventory = Array.isArray(lastRenderedStatus.inventory) ? lastRenderedStatus.inventory.filter(item => item && Number(item.count) > 0) : [];
  renderInventoryCards(inventory, inventoryModalContainer);
  inventoryModal.hidden = false;
  inventoryModal.querySelector('.inventory-modal-close').focus();
});

inventoryModal.querySelectorAll('[data-close-inventory]').forEach(button => {
  button.addEventListener('click', () => {
    inventoryModal.hidden = true;
    showAllInventoryButton.focus();
  });
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !inventoryModal.hidden) {
    inventoryModal.hidden = true;
    showAllInventoryButton.focus();
  }
});

function createGridEmptyState(message) {
  const empty = document.createElement('div');
  empty.className = 'empty-hint';
  empty.setAttribute('role', 'status');
  empty.textContent = message;
  return empty;
}

function appendLog(log) {
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
  logsContainer.appendChild(entry);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}

// フォーム送信
commandForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = commandInput.value.trim();
  if (!text) return;

  socket.emit('sendInstruction', { instruction: text, sender: 'WebDashboard' });
  commandInput.value = '';
});

// タスク中断
btnCancel.addEventListener('click', () => {
  socket.emit('cancelTask');
});

// クイックコマンドボタン
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cmd = btn.getAttribute('data-cmd');
    if (cmd) {
      if (cmd === 'ストップ' || cmd === translate('stopInMinecraft')) {
        socket.emit('cancelTask');
      } else {
        socket.emit('sendInstruction', { instruction: cmd, sender: 'WebDashboard' });
      }
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
languageSelect.value = window.craftMateI18n.language;
languageSelect.addEventListener('change', () => window.craftMateI18n.setLanguage(languageSelect.value));
const modelsByProvider = {
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
  groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
  ollama: ['llama3.1', 'qwen3', 'deepseek-r1'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
};

function populateModelOptions(provider, selectedModel) {
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
  settingsMessage.textContent = message || '';
  settingsMessage.className = `settings-message${state ? ` ${state}` : ''}`;
}

function updateCustomMinecraftVersionVisibility() {
  const isCustom = minecraftVersionSelect.value === 'custom';
  minecraftVersionCustomInput.hidden = !isCustom;
  minecraftVersionCustomInput.required = isCustom;
}

function setMinecraftVersionSetting(version) {
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

minecraftVersionSelect.addEventListener('change', updateCustomMinecraftVersionVisibility);

function setConnectionState(name, connected) {
  const dot = document.getElementById(`${name}-health-dot`);
  const label = document.getElementById(`${name}-health-label`);
  dot.className = `connection-dot ${connected ? 'online' : 'offline'}`;
  label.textContent = connected ? translate('connected') : translate('disconnected');
  label.style.color = connected ? 'var(--accent-green)' : 'var(--accent-red)';
}

async function refreshHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error(translate('healthCheckFailed'));
    const health = await response.json();
    setConnectionState('minecraft', health.minecraftConnected);
    setConnectionState('ai', health.aiConnected);
    document.getElementById('health-checked').textContent = translate('checked', { time: new Date().toLocaleTimeString() });
  } catch {
    setConnectionState('minecraft', false);
    setConnectionState('ai', false);
    document.getElementById('health-checked').textContent = translate('healthUnavailable');
  }
}

async function loadSettings() {
  try {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || translate('settingsLoadFailed'));
    document.getElementById('setting-mc-port').value = data.mcPort || 25565;
    setMinecraftVersionSetting(data.mcVersion || 'auto');
    document.getElementById('setting-username').value = data.username || 'AIMAN';
    document.getElementById('setting-web-port').value = data.webPort || 3000;
    providerSelect.value = data.provider || 'gemini';
    populateModelOptions(providerSelect.value, data.model);
    apiKeyInput.value = '';
    document.getElementById('api-key-help').textContent = data.apiKeyConfigured
      ? translate('keySaved')
      : translate('noKeySaved');
    showSettingsMessage('', '');
    await refreshHealth();
  } catch (error) {
    showSettingsMessage(error.message || translate('settingsLoadFailed'), 'error');
  }
}

document.getElementById('btn-settings').addEventListener('click', () => {
  settingsModal.hidden = false;
  document.getElementById('setting-mc-port').focus();
  loadSettings();
});
document.getElementById('btn-close-settings').addEventListener('click', () => { settingsModal.hidden = true; });
settingsModal.querySelector('[data-close-settings]').addEventListener('click', () => { settingsModal.hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !settingsModal.hidden) settingsModal.hidden = true;
});
providerSelect.addEventListener('change', () => {
  populateModelOptions(providerSelect.value);
  const needsKey = providerSelect.value !== 'ollama';
  document.getElementById('api-key-help').textContent = needsKey
    ? translate('keepKey')
    : translate('ollamaNoKey');
});

settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const saveButton = document.getElementById('btn-save-settings');
  saveButton.disabled = true;
  showSettingsMessage(translate('saving'));
  const payload = {
    mcPort: Number(document.getElementById('setting-mc-port').value),
    mcVersion: minecraftVersionSelect.value === 'custom'
      ? minecraftVersionCustomInput.value.trim()
      : minecraftVersionSelect.value,
    username: document.getElementById('setting-username').value.trim(),
    webPort: Number(document.getElementById('setting-web-port').value),
    provider: providerSelect.value,
    model: modelSelect.value,
    aiApiKey: apiKeyInput.value,
  };
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
    showSettingsMessage(error.message || translate('settingsSaveFailed'), 'error');
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
    const response = await fetch(url, { ...options, headers, cache: options.cache || 'no-store' });
    if (response.status !== 403 || attempt > 0) return response;
  }
  throw new Error(translate('updateAuthMissing'));
}

document.getElementById('btn-create-backup').addEventListener('click', async event => {
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
document.getElementById('btn-restore-backup').addEventListener('click', () => backupFileInput.click());
backupFileInput.addEventListener('change', async () => {
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

document.getElementById('btn-reconnect').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/reconnect', { method: 'POST' });
    if (!response.ok) throw new Error(translate('reconnectFailed'));
    showSettingsMessage(translate('reconnectStarted'), 'success');
  } catch (error) {
    showSettingsMessage(error.message, 'error');
  } finally {
    button.disabled = false;
    refreshHealth();
  }
});

document.getElementById('btn-ai-restart').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/ai/restart', { method: 'POST' });
    if (!response.ok) throw new Error(translate('aiRestartFailed'));
    showSettingsMessage(translate('aiRestarted'), 'success');
    refreshHealth();
  } catch (error) {
    showSettingsMessage(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('btn-check-updates').addEventListener('click', async event => {
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
  } catch (error) {
    showSettingsMessage(error.message || translate('updaterLaunchFailed'), 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('btn-download-logs').addEventListener('click', () => {
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
