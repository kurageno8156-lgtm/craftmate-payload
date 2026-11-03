const socket = io();

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
const entitiesContainer = document.getElementById('entities-container');

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
      llmInfo.textContent = `🧠 AI Brain: ${data.config.provider.toUpperCase()} (${data.config.model})`;
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
  updateConnectionUI(true);
  renderStatus(status);
});

socket.on('disconnect', () => {
  updateConnectionUI(false);
});

socket.on('taskStarted', (data) => {
  taskText.textContent = `[${data.requester}より]: "${data.task}"`;
  btnCancel.style.display = 'block';
  appendLog({
    status: 'acting',
    timestamp: new Date().toLocaleTimeString(),
    thought: `新しいタスクを開始します: "${data.task}" (依頼者: ${data.requester})`,
  });
});

socket.on('taskFinished', (data) => {
  taskText.textContent = '待機中 (指示を待っています)';
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
    text.textContent = 'Minecraft Online';
  } else {
    dot.className = 'dot offline';
    text.textContent = 'Minecraft Disconnected';
  }
}

function renderStatus(status) {
  if (!status) return;

  // HP & Food
  hpVal.textContent = status.health;
  hpBar.style.width = `${Math.max(0, Math.min(100, (status.health / 20) * 100))}%`;

  foodVal.textContent = status.food;
  foodBar.style.width = `${Math.max(0, Math.min(100, (status.food / 20) * 100))}%`;

  // Info
  posVal.textContent = `X: ${status.position.x}, Y: ${status.position.y}, Z: ${status.position.z}`;
  dimVal.textContent = status.dimension;
  biomeVal.textContent = status.biome;
  timeVal.textContent = status.gameTime;
  heldVal.textContent = status.heldItem || '素手';

  // Armor
  armorHelmet.innerHTML = `🪖 <span>${status.equippedArmor?.helmet || '-'}</span>`;
  armorChest.innerHTML = `🦺 <span>${status.equippedArmor?.chestplate || '-'}</span>`;
  armorLegs.innerHTML = `👖 <span>${status.equippedArmor?.leggings || '-'}</span>`;
  armorBoots.innerHTML = `👢 <span>${status.equippedArmor?.boots || '-'}</span>`;

  // Inventory
  invCount.textContent = status.inventory ? status.inventory.length : 0;
  if (status.inventory && status.inventory.length > 0) {
    invContainer.innerHTML = status.inventory.map(item => `
      <div class="inv-item" title="${item.name}">
        <span>${item.displayName || item.name}</span>
        <span class="inv-count">x${item.count}</span>
      </div>
    `).join('');
  } else {
    invContainer.innerHTML = '<div class="empty-hint">インベントリは空です</div>';
  }

  // Entities
  if (status.nearbyEntities && status.nearbyEntities.length > 0) {
    entitiesContainer.innerHTML = status.nearbyEntities.map(e => `
      <div class="entity-item ${e.isHostile ? 'hostile' : (e.isPlayer ? 'player' : '')}">
        <span>${e.isPlayer ? '👤 ' : (e.isHostile ? '👾 ' : '🐾 ')}${e.name}</span>
        <span>${e.distance}m</span>
      </div>
    `).join('');
  } else {
    entitiesContainer.innerHTML = '<div class="empty-hint">周囲にエンティティはいません</div>';
  }

  // Task Status
  if (status.currentTask) {
    taskText.textContent = `実行中: "${status.currentTask}"`;
    btnCancel.style.display = 'block';
  } else if (!status.isExecuting) {
    taskText.textContent = '待機中 (指示を待っています)';
    btnCancel.style.display = 'none';
  }
}

function appendLog(log) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${log.status || 'acting'}`;

  let html = `<div class="log-meta">
    <span>Step ${log.stepNumber || 0} [${log.status.toUpperCase()}]</span>
    <span>${log.timestamp || new Date().toLocaleTimeString()}</span>
  </div>`;

  if (log.thought) {
    html += `<div class="log-thought">💭 ${escapeHtml(log.thought)}</div>`;
  }
  if (log.actionName) {
    const paramsStr = log.actionParams ? JSON.stringify(log.actionParams) : '';
    html += `<div class="log-action">⚡ Action: ${log.actionName}(${escapeHtml(paramsStr)})</div>`;
  }
  if (log.observation) {
    html += `<div class="log-obs">📋 Observation: ${escapeHtml(log.observation)}</div>`;
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
      if (cmd === 'ストップ') {
        socket.emit('cancelTask');
      } else {
        socket.emit('sendInstruction', { instruction: cmd, sender: 'WebDashboard' });
      }
    }
  });
});
