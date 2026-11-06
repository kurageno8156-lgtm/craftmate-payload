(function () {
  const dictionaries = {
    en: {
      pageTitle: 'Minecraft AI Agent Dashboard', connecting: 'Connecting...', settingsButton: '⚙️ Settings',
      botStatus: '📊 Bot Status', aiBrain: '🧠 AI Brain: {provider} ({model})', health: 'Health', food: 'Food', coordinates: '📍 Coordinates', dimension: '🌍 Dimension', biome: '🌲 Biome', time: '☀️ Time', heldItem: '🗡️ Held Item',
      equipment: '🛡️ Equipment', inventory: 'Inventory', items: 'items', emptyInventory: 'Inventory is empty', nearbyEntities: '👀 Nearby Entities', noEntities: 'No nearby entities',
      currentGoal: '🎯 Current Goal', stopTask: 'Stop task', waitingForTask: 'Waiting for instructions', aiLogTitle: '🧠 AI Activity Log (Thoughts & Actions)', systemReady: 'AI bot is ready. Send an instruction below or through Minecraft chat.',
      quickFollow: 'Follow me', quickChop: 'Collect 3 logs', quickPickaxe: 'Craft a wooden pickaxe', quickDefend: 'Defend against monsters', quickGive: 'Give me your wood', quickStop: 'Stop',
      commandPlaceholder: 'Enter an instruction... (e.g. Mine 5 logs and craft a crafting table)', sendInstruction: 'Send instruction 🚀', controlPanel: 'CRAFTMATE CONTROL', settingsTitle: '⚙️ Settings', closeSettings: 'Close settings',
      languageLabel: 'Language / 言語', mcPortLabel: 'Minecraft LAN port', mcPortHelp: 'Default: 25565', botNameLabel: 'Bot name', botNameHelp: '1–16 letters, numbers, or underscores', webPortLabel: 'Web server port', webPortHelp: 'Default: 3000',
      providerLabel: 'AI provider', modelLabel: 'Model', modelHelp: 'Choose the model used by the selected provider.', apiKeyLabel: 'Provider API key (optional)', apiKeyPlaceholder: 'Leave blank to keep the saved key', apiKeyHelp: 'Your key stays on this server and is never displayed.', settingsNote: 'Changes save to the local .env file.', saveSettings: 'Save settings', connections: 'Connections', checking: 'Checking…', minecraft: 'Minecraft', aiProvider: 'AI provider',
      reconnect: '↻ Reconnect Minecraft', restartAI: '⟳ Restart AI client', checkUpdates: '↻ Check for updates', downloadLogs: '↓ Download logs', updateProgress: 'Update progress',
      online: 'Minecraft Online', offline: 'Minecraft Disconnected', connected: 'Connected', disconnected: 'Disconnected', healthCheckFailed: 'Health check failed', healthUnavailable: 'Status unavailable', checked: 'Checked {time}',
      keySaved: 'A key is saved. Enter a new one only if you want to replace it.', noKeySaved: 'No key is saved for this provider. Ollama does not need an API key.', keepKey: 'Leave blank to keep the saved key; enter a key only to add or replace it.', ollamaNoKey: 'Ollama runs locally and does not need an API key.',
      saving: 'Saving settings…', settingsSaved: 'Settings saved.', reconnecting: 'Saved. Minecraft is reconnecting with the new settings.', reopeningPort: 'Saved. Reopening the dashboard on its new port…', settingsLoadFailed: 'Could not load settings.', settingsSaveFailed: 'Could not save settings.',
      reconnectStarted: 'Minecraft reconnect started.', reconnectFailed: 'Minecraft reconnect failed', aiRestarted: 'AI client reloaded with the saved provider settings.', aiRestartFailed: 'AI client restart failed', checkingUpdates: 'Checking for updates…', currentVersion: "You're up to date (v{version}).",
      determineVersionFailed: 'Could not determine the current version.', githubCheckFailed: 'Could not check GitHub releases.', noReleaseVersion: 'The latest GitHub release has no version tag.', updateAvailable: 'A new version v{version} is available. Update now?', updateDeclined: 'Update v{version} is available.',
      updateAuthMissing: 'The local update authentication token is missing. Reload the dashboard and try again.', updateStarting: 'Starting update…', updateDownloading: 'Downloading update…', updateApplying: 'Applying update…', updateStartFailed: 'Could not start the update.', updateCompleted: 'The update is complete. Please restart the app.', updateFailed: 'Update failed.', updateTimeout: 'Update v{version} is taking longer than expected. Check the dashboard again shortly.',
      logStep: 'Step {step} [{status}]', logAction: '⚡ Action: {action}({params})', logObservation: '📋 Observation: {text}', stopInMinecraft: 'stop', emptyTask: 'Waiting for instructions', activeTask: 'Running: "{task}"', taskFrom: '[{requester}]: "{task}"', newTask: 'Starting task: "{task}" (requested by {requester})',
      statusIdle: 'IDLE', statusThinking: 'THINKING', statusActing: 'ACTING', statusSuccess: 'SUCCESS', statusError: 'ERROR', statusCompleted: 'COMPLETED', statusCancelled: 'CANCELLED', statusSystem: 'SYSTEM', statusUnknown: 'UNKNOWN',
      overworld: 'Overworld', nether: 'Nether', theEnd: 'The End', daytime: 'Day', nighttime: 'Night', bareHands: 'Bare hands',
    },
    ja: {
      pageTitle: 'Minecraft AI Agent ダッシュボード', connecting: '接続中...', settingsButton: '⚙️ 設定',
      botStatus: '📊 ボットの状態', aiBrain: '🧠 AI 脳: {provider} ({model})', health: '体力', food: '満腹度', coordinates: '📍 座標', dimension: '🌍 ディメンション', biome: '🌲 バイオーム', time: '☀️ 時刻', heldItem: '🗡️ 手持ちアイテム',
      equipment: '🛡️ 装備', inventory: 'インベントリ', items: '個', emptyInventory: 'インベントリは空です', nearbyEntities: '👀 周囲のエンティティ', noEntities: '周囲にエンティティはいません',
      currentGoal: '🎯 現在の目標', stopTask: 'タスクを中断', waitingForTask: '待機中（指示を待っています）', aiLogTitle: '🧠 AIの思考・行動ログ', systemReady: 'AIボットは待機中です。下のフォームまたはMinecraftチャットから指示してください。',
      quickFollow: 'ついてきて', quickChop: '原木を3個集める', quickPickaxe: '木のツルハシを作る', quickDefend: 'モンスターから身を守る', quickGive: '木材を渡して', quickStop: '停止',
      commandPlaceholder: 'AIへの指示を入力...（例: 原木を5個集めて作業台を作る）', sendInstruction: '指示を送信 🚀', controlPanel: 'CRAFTMATE コントロール', settingsTitle: '⚙️ 設定', closeSettings: '設定を閉じる',
      languageLabel: 'Language / 言語', mcPortLabel: 'Minecraft LAN ポート', mcPortHelp: '既定値: 25565', botNameLabel: 'ボット名', botNameHelp: '英数字とアンダースコアで1〜16文字', webPortLabel: 'Webサーバーのポート', webPortHelp: '既定値: 3000',
      providerLabel: 'AIプロバイダー', modelLabel: 'モデル', modelHelp: '選択したプロバイダーで使用するモデルを選びます。', apiKeyLabel: 'プロバイダー API キー（任意）', apiKeyPlaceholder: '保存済みのキーを維持する場合は空欄', apiKeyHelp: 'キーはこのサーバーに保存され、画面には表示されません。', settingsNote: '変更はローカルの .env ファイルに保存されます。', saveSettings: '設定を保存', connections: '接続状態', checking: '確認中…', minecraft: 'Minecraft', aiProvider: 'AIプロバイダー',
      reconnect: '↻ Minecraft 再接続', restartAI: '⟳ AIクライアント再起動', checkUpdates: '↻ 更新を確認', downloadLogs: '↓ ログをダウンロード', updateProgress: '更新の進捗',
      online: 'Minecraft 接続中', offline: 'Minecraft 切断中', connected: '接続済み', disconnected: '未接続', healthCheckFailed: '接続確認に失敗しました', healthUnavailable: '状態を取得できません', checked: '{time} に確認',
      keySaved: 'キーを保存済みです。変更する場合のみ新しいキーを入力してください。', noKeySaved: 'このプロバイダーのキーは未設定です。OllamaではAPIキーは不要です。', keepKey: '保存済みキーを維持する場合は空欄にし、追加・変更時のみ入力してください。', ollamaNoKey: 'Ollamaはローカルで動作するためAPIキーは不要です。',
      saving: '設定を保存中…', settingsSaved: '設定を保存しました。', reconnecting: '保存しました。Minecraftを新しい設定で再接続しています。', reopeningPort: '保存しました。新しいポートでダッシュボードを開きます…', settingsLoadFailed: '設定を読み込めませんでした。', settingsSaveFailed: '設定を保存できませんでした。',
      reconnectStarted: 'Minecraftの再接続を開始しました。', reconnectFailed: 'Minecraftの再接続に失敗しました', aiRestarted: '保存済みのプロバイダー設定でAIクライアントを再読み込みしました。', aiRestartFailed: 'AIクライアントの再起動に失敗しました', checkingUpdates: '更新を確認中…', currentVersion: '最新バージョンです（v{version}）。',
      determineVersionFailed: '現在のバージョンを取得できませんでした。', githubCheckFailed: 'GitHubのリリースを確認できませんでした。', noReleaseVersion: '最新のGitHubリリースにバージョンタグがありません。', updateAvailable: '新しいバージョン v{version} があります。今すぐアップデートしますか？', updateDeclined: 'バージョン v{version} に更新できます。',
      updateAuthMissing: 'ローカル更新用の認証トークンがありません。ページを再読み込みしてください。', updateStarting: 'アップデートを開始しています…', updateDownloading: 'アップデートをダウンロード中…', updateApplying: 'アップデートを適用中…', updateStartFailed: 'アップデートを開始できませんでした。', updateCompleted: 'アップデートが完了しました。アプリを再起動してください', updateFailed: 'アップデートに失敗しました。', updateTimeout: 'バージョン v{version} の更新に時間がかかっています。しばらくしてから画面を確認してください。',
      logStep: 'ステップ {step} [{status}]', logAction: '⚡ アクション: {action}({params})', logObservation: '📋 観察: {text}', stopInMinecraft: '停止', emptyTask: '待機中（指示を待っています）', activeTask: '実行中:「{task}」', taskFrom: '[{requester}から]:「{task}」', newTask: 'タスクを開始します:「{task}」（依頼者: {requester}）',
      statusIdle: '待機中', statusThinking: '思考中', statusActing: '行動中', statusSuccess: '成功', statusError: 'エラー', statusCompleted: '完了', statusCancelled: 'キャンセル', statusSystem: 'システム', statusUnknown: '不明',
      overworld: 'オーバーワールド', nether: 'ネザー', theEnd: 'ジ・エンド', daytime: '昼間', nighttime: '夜間', bareHands: '素手',
    },
  };

  let language = localStorage.getItem('craftmate-language');
  if (language !== 'ja' && language !== 'en') language = (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';

  function translate(key, values) {
    const dictionary = dictionaries[language] || dictionaries.en;
    let message = dictionary[key] || dictionaries.en[key] || key;
    for (const [name, value] of Object.entries(values || {})) message = message.replaceAll(`{${name}}`, String(value));
    return message;
  }

  function apply() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = translate(element.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
      element.setAttribute('placeholder', translate(element.dataset.i18nPlaceholder));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(element => {
      element.setAttribute('aria-label', translate(element.dataset.i18nAria));
    });
    document.querySelectorAll('.quick-btn').forEach(button => {
      button.dataset.cmd = language === 'en' ? button.dataset.cmdEn : button.dataset.cmdJa || button.dataset.cmd;
    });
    const selector = document.getElementById('setting-language');
    if (selector) selector.value = language;
    document.dispatchEvent(new CustomEvent('craftmate-language-changed', { detail: { language } }));
  }

  window.craftMateI18n = {
    t: translate,
    get language() { return language; },
    setLanguage(nextLanguage) {
      if (!dictionaries[nextLanguage]) return;
      language = nextLanguage;
      localStorage.setItem('craftmate-language', language);
      apply();
    },
    apply,
  };

  document.addEventListener('DOMContentLoaded', apply);
})();
