(function () {
  const dictionaries = {
    en: {
      pageTitle: 'Minecraft AI Agent Dashboard', connecting: 'Connecting...', settingsButton: '⚙️ Settings',
      botStatus: '📊 Bot Status', aiBrain: '🧠 AI Brain: {provider} ({model})', health: 'Health', food: 'Food', coordinates: '📍 Coordinates', dimension: '🌍 Dimension', biome: '🌲 Biome', time: '☀️ Time', heldItem: '🗡️ Held Item',
      equipment: '🛡️ Equipment', inventory: 'Inventory', items: 'items', emptyInventory: 'No items in inventory', unknownItem: 'Unknown item', unknownEntity: 'Unknown entity', showAllItems: 'Show all (all {count})', inventoryModalTitle: 'All inventory items', close: 'Close', closeInventory: 'Close inventory', nearbyEntities: '👀 Nearby Entities', noEntities: 'No nearby entities',
      restorePermissionDenied: 'Windows denied access to .env. Install CraftMate in a folder you can write to, or run it with permission to modify the installation folder.', restoreWriteFailed: 'Windows could not replace .env. Close CraftMate and try restoring the backup again.',
      entityCategory_player: 'Player', entityCategory_hostile: 'Hostile mob', entityCategory_animal: 'Animal', entityCategory_item: 'Dropped item', entityCategory_other: 'Entity',
      entityName_zombie: 'Zombie', entityName_skeleton: 'Skeleton', entityName_creeper: 'Creeper', entityName_spider: 'Spider', entityName_cave_spider: 'Cave Spider', entityName_enderman: 'Enderman', entityName_witch: 'Witch', entityName_slime: 'Slime', entityName_drowned: 'Drowned', entityName_husk: 'Husk', entityName_stray: 'Stray', entityName_phantom: 'Phantom', entityName_pillager: 'Pillager', entityName_vindicator: 'Vindicator', entityName_evoker: 'Evoker', entityName_ravager: 'Ravager', entityName_hoglin: 'Hoglin', entityName_piglin_brute: 'Piglin Brute', entityName_warden: 'Warden', entityName_cow: 'Cow', entityName_mooshroom: 'Mooshroom', entityName_pig: 'Pig', entityName_sheep: 'Sheep', entityName_chicken: 'Chicken', entityName_horse: 'Horse', entityName_donkey: 'Donkey', entityName_wolf: 'Wolf', entityName_cat: 'Cat', entityName_ocelot: 'Ocelot', entityName_villager: 'Villager', entityName_iron_golem: 'Iron Golem', entityName_bat: 'Bat', entityName_bee: 'Bee', entityName_fox: 'Fox', entityName_rabbit: 'Rabbit', entityName_turtle: 'Turtle', entityName_dolphin: 'Dolphin', entityName_goat: 'Goat', entityName_llama: 'Llama', entityName_panda: 'Panda', entityName_parrot: 'Parrot',
      itemName_oak_log: 'Oak Log', itemName_spruce_log: 'Spruce Log', itemName_birch_log: 'Birch Log', itemName_jungle_log: 'Jungle Log', itemName_acacia_log: 'Acacia Log', itemName_dark_oak_log: 'Dark Oak Log', itemName_mangrove_log: 'Mangrove Log', itemName_cherry_log: 'Cherry Log', itemName_oak_planks: 'Oak Planks', itemName_stick: 'Stick', itemName_cobblestone: 'Cobblestone', itemName_stone: 'Stone', itemName_dirt: 'Dirt', itemName_sand: 'Sand', itemName_coal: 'Coal', itemName_iron_ingot: 'Iron Ingot', itemName_gold_ingot: 'Gold Ingot', itemName_diamond: 'Diamond', itemName_emerald: 'Emerald', itemName_bread: 'Bread', itemName_cooked_beef: 'Steak', itemName_beef: 'Raw Beef', itemName_cooked_porkchop: 'Cooked Porkchop', itemName_porkchop: 'Raw Porkchop', itemName_cooked_chicken: 'Cooked Chicken', itemName_chicken: 'Raw Chicken', itemName_apple: 'Apple', itemName_torch: 'Torch', itemName_crafting_table: 'Crafting Table', itemName_wooden_pickaxe: 'Wooden Pickaxe', itemName_stone_pickaxe: 'Stone Pickaxe', itemName_iron_pickaxe: 'Iron Pickaxe', itemName_diamond_pickaxe: 'Diamond Pickaxe', itemName_wooden_sword: 'Wooden Sword', itemName_iron_sword: 'Iron Sword',
      currentGoal: '🎯 Current Goal', stopTask: 'Stop task', waitingForTask: 'Waiting for instructions', aiLogTitle: '🧠 AI Activity Log (Thoughts & Actions)', systemReady: 'AI bot is ready. Send an instruction below or through Minecraft chat.',
      quickFollow: 'Follow me', quickChop: 'Collect 3 logs', quickPickaxe: 'Craft a wooden pickaxe', quickDefend: 'Defend against monsters', quickGive: 'Give me your wood', quickStop: 'Stop',
      commandPlaceholder: 'Enter an instruction... (e.g. Mine 5 logs and craft a crafting table)', sendInstruction: 'Send instruction 🚀', controlPanel: 'CRAFTMATE CONTROL', settingsTitle: '⚙️ Settings', closeSettings: 'Close settings',
      languageLabel: 'Language / 言語', mcPortLabel: 'Minecraft LAN port', mcPortHelp: 'Default: 25565', mcVersionLabel: 'Minecraft version', mcVersionHelp: 'Choose a supported version or enter a custom version.', minecraftVersionPlaceholder: 'auto', autoDetect: 'Auto-detect (auto)', otherVersion: 'Other (manual input)', mcVersionCustomPlaceholder: 'Enter version (for example, 1.21.11)', botNameLabel: 'Bot name', botNameHelp: '1–16 letters, numbers, or underscores', webPortLabel: 'Web server port', webPortHelp: 'Default: 3000',
      providerLabel: 'AI provider', modelLabel: 'Model', modelHelp: 'Choose the model used by the selected provider.', apiKeyLabel: 'Provider API key (optional)', apiKeyPlaceholder: 'Leave blank to keep the saved key', apiKeyHelp: 'Your key stays on this server and is never displayed.', settingsNote: 'Changes save to the local .env file.', saveSettings: 'Save settings', backupTools: 'Settings backup', createBackup: 'Create backup', restoreBackup: 'Restore from backup', connections: 'Connections', checking: 'Checking…', minecraft: 'Minecraft', aiProvider: 'AI provider',
      reconnect: '↻ Reconnect Minecraft', restartAI: '⟳ Restart AI client', checkUpdates: '↻ Open updater', downloadLogs: '↓ Download logs', launchingUpdater: 'Launching the updater…', updaterLaunched: 'The updater has been started.', updaterLaunchFailed: 'Could not start the updater.',
      online: 'Minecraft Online', offline: 'Minecraft Disconnected', connected: 'Connected', disconnected: 'Disconnected', healthCheckFailed: 'Health check failed', healthUnavailable: 'Status unavailable', checked: 'Checked {time}',
      keySaved: 'A key is saved. Enter a new one only if you want to replace it.', noKeySaved: 'No key is saved for this provider. Ollama does not need an API key.', keepKey: 'Leave blank to keep the saved key; enter a key only to add or replace it.', ollamaNoKey: 'Ollama runs locally and does not need an API key.',
      saving: 'Saving settings…', settingsSaved: 'Settings saved.', reconnecting: 'Saved. Minecraft is reconnecting with the new settings.', reopeningPort: 'Saved. Reopening the dashboard on its new port…', settingsLoadFailed: 'Could not load settings.', settingsSaveFailed: 'Could not save settings.', backupCreated: 'Settings backup downloaded: {fileName}', backupFailed: 'Could not create the settings backup.', chooseBackup: 'Choose a CraftMate backup JSON file.', restoreConfirm: 'Restore settings from this backup? This will replace the current .env settings.', restoringBackup: 'Restoring settings…', restoreSuccess: 'Settings restored. Reloading the dashboard…', restoreFailed: 'Could not restore settings.', invalidBackup: 'This is not a valid CraftMate settings backup.',
      reconnectStarted: 'Minecraft reconnect started.', reconnectFailed: 'Minecraft reconnect failed', aiRestarted: 'AI client reloaded with the saved provider settings.', aiRestartFailed: 'AI client restart failed', checkingUpdates: 'Checking for updates…', currentVersion: "You're up to date (v{version}).",
      determineVersionFailed: 'Could not determine the current version.', githubCheckFailed: 'Could not check GitHub releases.', noReleaseVersion: 'The latest GitHub release has no version tag.', updateAvailable: 'A new version v{version} is available. Update now?', updateDeclined: 'Update v{version} is available.',
      updateAuthMissing: 'The local update authentication token is missing. Reload the dashboard and try again.', updateStarting: 'Starting update…', updateDownloading: 'Downloading update…', updateApplying: 'Applying update…', updateStartFailed: 'Could not start the update.', updateCompleted: 'The update is complete. Please restart the app.', updateFailed: 'Update failed.', updateTimeout: 'Update v{version} timed out. See log: {logPath}',
      logStep: 'Step {step} [{status}]', logAction: '⚡ Action: {action}({params})', logObservation: '📋 Observation: {text}', stopInMinecraft: 'stop', emptyTask: 'Waiting for instructions', activeTask: 'Running: "{task}"', taskFrom: '[{requester}]: "{task}"', newTask: 'Starting task: "{task}" (requested by {requester})',
      statusIdle: 'IDLE', statusThinking: 'THINKING', statusActing: 'ACTING', statusSuccess: 'SUCCESS', statusError: 'ERROR', statusCompleted: 'COMPLETED', statusCancelled: 'CANCELLED', statusSystem: 'SYSTEM', statusUnknown: 'UNKNOWN',
      overworld: 'Overworld', nether: 'Nether', theEnd: 'The End', daytime: 'Day', nighttime: 'Night', bareHands: 'Bare hands',
    },
    ja: {
      pageTitle: 'Minecraft AI Agent ダッシュボード', connecting: '接続中...', settingsButton: '⚙️ 設定',
      botStatus: '📊 ボットの状態', aiBrain: '🧠 AI 脳: {provider} ({model})', health: '体力', food: '満腹度', coordinates: '📍 座標', dimension: '🌍 ディメンション', biome: '🌲 バイオーム', time: '☀️ 時刻', heldItem: '🗡️ 手持ちアイテム',
      equipment: '🛡️ 装備', inventory: 'インベントリ', items: '個', emptyInventory: 'アイテムを持っていません', unknownItem: '不明なアイテム', unknownEntity: '不明なエンティティ', showAllItems: 'すべて表示（全{count}個）', inventoryModalTitle: 'インベントリ一覧', close: '閉じる', closeInventory: 'インベントリを閉じる', nearbyEntities: '👀 周囲のエンティティ', noEntities: '周囲にエンティティはいません',
      restorePermissionDenied: 'Windowsが.envへの書き込みを拒否しました。書き込み可能なフォルダーにCraftMateをインストールするか、インストール先を変更できる権限で実行してください。', restoreWriteFailed: 'Windowsが.envを置き換えられませんでした。.envを使用中のCraftMateを閉じて、もう一度復元してください。',
      entityCategory_player: 'プレイヤー', entityCategory_hostile: '敵対Mob', entityCategory_animal: '動物', entityCategory_item: 'ドロップアイテム', entityCategory_other: 'エンティティ',
      entityName_zombie: 'ゾンビ', entityName_skeleton: 'スケルトン', entityName_creeper: 'クリーパー', entityName_spider: 'クモ', entityName_cave_spider: '洞窟グモ', entityName_enderman: 'エンダーマン', entityName_witch: 'ウィッチ', entityName_slime: 'スライム', entityName_drowned: 'ドラウンド', entityName_husk: 'ハスク', entityName_stray: 'ストレイ', entityName_phantom: 'ファントム', entityName_pillager: 'ピリジャー', entityName_vindicator: 'ヴィンディケーター', entityName_evoker: 'エヴォーカー', entityName_ravager: 'ラヴェジャー', entityName_hoglin: 'ホグリン', entityName_piglin_brute: 'ピグリンブルート', entityName_warden: 'ウォーデン', entityName_cow: 'ウシ', entityName_mooshroom: 'ムーシュルーム', entityName_pig: 'ブタ', entityName_sheep: 'ヒツジ', entityName_chicken: 'ニワトリ', entityName_horse: 'ウマ', entityName_donkey: 'ロバ', entityName_wolf: 'オオカミ', entityName_cat: 'ネコ', entityName_ocelot: 'ヤマネコ', entityName_villager: '村人', entityName_iron_golem: 'アイアンゴーレム', entityName_bat: 'コウモリ', entityName_bee: 'ハチ', entityName_fox: 'キツネ', entityName_rabbit: 'ウサギ', entityName_turtle: 'カメ', entityName_dolphin: 'イルカ', entityName_goat: 'ヤギ', entityName_llama: 'ラマ', entityName_panda: 'パンダ', entityName_parrot: 'オウム',
      itemName_oak_log: 'オークの原木', itemName_spruce_log: 'トウヒの原木', itemName_birch_log: 'シラカバの原木', itemName_jungle_log: 'ジャングルの原木', itemName_acacia_log: 'アカシアの原木', itemName_dark_oak_log: 'ダークオークの原木', itemName_mangrove_log: 'マングローブの原木', itemName_cherry_log: 'サクラの原木', itemName_oak_planks: 'オークの板材', itemName_stick: '棒', itemName_cobblestone: '丸石', itemName_stone: '石', itemName_dirt: '土', itemName_sand: '砂', itemName_coal: '石炭', itemName_iron_ingot: '鉄インゴット', itemName_gold_ingot: '金インゴット', itemName_diamond: 'ダイヤモンド', itemName_emerald: 'エメラルド', itemName_bread: 'パン', itemName_cooked_beef: 'ステーキ', itemName_beef: '生の牛肉', itemName_cooked_porkchop: '焼き豚', itemName_porkchop: '生の豚肉', itemName_cooked_chicken: '焼き鳥', itemName_chicken: '生の鶏肉', itemName_apple: 'リンゴ', itemName_torch: '松明', itemName_crafting_table: '作業台', itemName_wooden_pickaxe: '木のツルハシ', itemName_stone_pickaxe: '石のツルハシ', itemName_iron_pickaxe: '鉄のツルハシ', itemName_diamond_pickaxe: 'ダイヤモンドのツルハシ', itemName_wooden_sword: '木の剣', itemName_iron_sword: '鉄の剣',
      currentGoal: '🎯 現在の目標', stopTask: 'タスクを中断', waitingForTask: '待機中（指示を待っています）', aiLogTitle: '🧠 AIの思考・行動ログ', systemReady: 'AIボットは待機中です。下のフォームまたはMinecraftチャットから指示してください。',
      quickFollow: 'ついてきて', quickChop: '原木を3個集める', quickPickaxe: '木のツルハシを作る', quickDefend: 'モンスターから身を守る', quickGive: '木材を渡して', quickStop: '停止',
      commandPlaceholder: 'AIへの指示を入力...（例: 原木を5個集めて作業台を作る）', sendInstruction: '指示を送信 🚀', controlPanel: 'CRAFTMATE コントロール', settingsTitle: '⚙️ 設定', closeSettings: '設定を閉じる',
      languageLabel: 'Language / 言語', mcPortLabel: 'Minecraft LAN ポート', mcPortHelp: '既定値: 25565', mcVersionLabel: 'Minecraft バージョン', mcVersionHelp: '対応バージョンを選ぶか、その他から任意のバージョンを入力してください。', minecraftVersionPlaceholder: 'auto', autoDetect: '自動検出 (auto)', otherVersion: 'その他（手動入力）', mcVersionCustomPlaceholder: 'バージョンを入力（例: 1.21.11）', botNameLabel: 'ボット名', botNameHelp: '英数字とアンダースコアで1〜16文字', webPortLabel: 'Webサーバーのポート', webPortHelp: '既定値: 3000',
      providerLabel: 'AIプロバイダー', modelLabel: 'モデル', modelHelp: '選択したプロバイダーで使用するモデルを選びます。', apiKeyLabel: 'プロバイダー API キー（任意）', apiKeyPlaceholder: '保存済みのキーを維持する場合は空欄', apiKeyHelp: 'キーはこのサーバーに保存され、画面には表示されません。', settingsNote: '変更はローカルの .env ファイルに保存されます。', saveSettings: '設定を保存', backupTools: '設定のバックアップ', createBackup: 'バックアップを作成', restoreBackup: 'バックアップから復元', connections: '接続状態', checking: '確認中…', minecraft: 'Minecraft', aiProvider: 'AIプロバイダー',
      reconnect: '↻ Minecraft 再接続', restartAI: '⟳ AIクライアント再起動', checkUpdates: '↻ アップデーターを起動', downloadLogs: '↓ ログをダウンロード', launchingUpdater: 'アップデーターを起動しています…', updaterLaunched: 'アップデーターを起動しました。', updaterLaunchFailed: 'アップデーターを起動できませんでした。',
      online: 'Minecraft 接続中', offline: 'Minecraft 切断中', connected: '接続済み', disconnected: '未接続', healthCheckFailed: '接続確認に失敗しました', healthUnavailable: '状態を取得できません', checked: '{time} に確認',
      keySaved: 'キーを保存済みです。変更する場合のみ新しいキーを入力してください。', noKeySaved: 'このプロバイダーのキーは未設定です。OllamaではAPIキーは不要です。', keepKey: '保存済みキーを維持する場合は空欄にし、追加・変更時のみ入力してください。', ollamaNoKey: 'Ollamaはローカルで動作するためAPIキーは不要です。',
      saving: '設定を保存中…', settingsSaved: '設定を保存しました。', reconnecting: '保存しました。Minecraftを新しい設定で再接続しています。', reopeningPort: '保存しました。新しいポートでダッシュボードを開きます…', settingsLoadFailed: '設定を読み込めませんでした。', settingsSaveFailed: '設定を保存できませんでした。', backupCreated: '設定バックアップをダウンロードしました: {fileName}', backupFailed: '設定バックアップを作成できませんでした。', chooseBackup: 'CraftMate のバックアップ JSON ファイルを選択してください。', restoreConfirm: 'このバックアップから設定を復元しますか？現在の .env 設定は置き換えられます。', restoringBackup: '設定を復元中…', restoreSuccess: '設定を復元しました。ダッシュボードを再読み込みします…', restoreFailed: '設定を復元できませんでした。', invalidBackup: 'CraftMate の有効な設定バックアップではありません。',
      reconnectStarted: 'Minecraftの再接続を開始しました。', reconnectFailed: 'Minecraftの再接続に失敗しました', aiRestarted: '保存済みのプロバイダー設定でAIクライアントを再読み込みしました。', aiRestartFailed: 'AIクライアントの再起動に失敗しました', checkingUpdates: '更新を確認中…', currentVersion: '最新バージョンです（v{version}）。',
      determineVersionFailed: '現在のバージョンを取得できませんでした。', githubCheckFailed: 'GitHubのリリースを確認できませんでした。', noReleaseVersion: '最新のGitHubリリースにバージョンタグがありません。', updateAvailable: '新しいバージョン v{version} があります。今すぐアップデートしますか？', updateDeclined: 'バージョン v{version} に更新できます。',
      updateAuthMissing: 'ローカル更新用の認証トークンがありません。ページを再読み込みしてください。', updateStarting: 'アップデートを開始しています…', updateDownloading: 'アップデートをダウンロード中…', updateApplying: 'アップデートを適用中…', updateStartFailed: 'アップデートを開始できませんでした。', updateCompleted: 'アップデートが完了しました。アプリを再起動してください', updateFailed: 'アップデートに失敗しました。', updateTimeout: 'バージョン v{version} の更新がタイムアウトしました。ログを確認してください: {logPath}',
      logStep: 'ステップ {step} [{status}]', logAction: '⚡ アクション: {action}({params})', logObservation: '📋 観察: {text}', stopInMinecraft: '停止', emptyTask: '待機中（指示を待っています）', activeTask: '実行中:「{task}」', taskFrom: '[{requester}から]:「{task}」', newTask: 'タスクを開始します:「{task}」（依頼者: {requester}）',
      statusIdle: '待機中', statusThinking: '思考中', statusActing: '行動中', statusSuccess: '成功', statusError: 'エラー', statusCompleted: '完了', statusCancelled: 'キャンセル', statusSystem: 'システム', statusUnknown: '不明',
      overworld: 'オーバーワールド', nether: 'ネザー', theEnd: 'ジ・エンド', daytime: '昼間', nighttime: '夜間', bareHands: '素手',
      ko: { 
        pageTitle: '마인크래프트 AI 에이전트 대시보드', 
        settingsButton: '설정', 
        botStatus: '봇 상태' 
      },
      es: { 
        pageTitle: 'Panel de Control del Agente AI de Minecraft', 
        settingsButton: 'Configuración', 
        botStatus: 'Estado del Bot' 
      },
      id: { 
        pageTitle: 'Dasbor Agen AI Minecraft', 
        settingsButton: 'Pengaturan', 
        botStatus: 'Status Bot' 
      },
      zh: { 
        pageTitle: '我的世界 AI 智能体仪表板', 
        settingsButton: '设置', 
        botStatus: '机器人状态' 
      },
      hi: { 
        pageTitle: 'Minecraft AI एजेंट डैशबोर्ड', 
        settingsButton: 'सेटिंग्स', 
        botStatus: 'बॉट स्थिति' 
      },

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
