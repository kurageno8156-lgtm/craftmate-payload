// CraftMate Bedrock — Minecraft統合版専用アドオンのコアスクリプト。
// @minecraft/server Script API でゲーム内完結。LANポート不使用・シングルプレイ対応。
//
// 使い方（ゲーム内チャット）:
//   !craftmate help / craftmate help / !CRAFTMATE HELP  … すべて有効（大文字小文字無視）
//   !craftmate <command> [args]
//
// 対応コマンド:
//   help / status / say <msg> / follow / stop / come
//   build <家|塔|橋|house|tower|bridge> / time <day|night> / weather <clear|rain|thunder>
//   give <item> <count> / tp <x> <y> <z> / pos
//   bot spawn|dismiss （コンパニオン召喚・消去）
//
// 日本語の自然言語（「家建てて」「夜にして」等）も一部解釈します。
import { world, system, ItemStack, CustomCommandStatus, CommandPermissionLevel } from '@minecraft/server';

const BOT_NAME = 'CraftMate';
const BOT_TAG = 'craftmate_bot';

let botEntity = null;
let followEnabled = false;
const followers = new Map(); // playerName -> boolean

// ---------- ユーティリティ ----------
function tell(player, text) {
  try { player.sendMessage(`§a[CraftMate] §f${text}`); } catch { /* ignore */ }
}
function usage(player) {
  tell(player, '使用方法: !craftmate help を参照してください。');
}
// HUD 風フィードバック: アクションバーに直近コマンド結果を表示
function hud(player, text) {
  try { player.onScreenDisplay.setActionBar(`§b⚒ §f${text}`); } catch { /* ignore */ }
}
// コマンド実行（非同期・成否を返す）
async function run(player, cmd) {
  try {
    const ok = await player.dimension.runCommandAsync(cmd);
    return !!ok;
  } catch {
    try { world.getDimension('overworld').runCommand(cmd); return true; } catch { return false; }
  }
}

function getBot() {
  if (botEntity && botEntity.isValid()) return botEntity;
  try {
    const found = world.getDimension('overworld').getEntities({ tags: [BOT_TAG] });
    botEntity = found.length ? found[0] : null;
  } catch { botEntity = null; }
  return botEntity;
}

function requireBot(player) {
  const bot = getBot();
  if (!bot) {
    tell(player, 'ボットがいません。まず !craftmate bot spawn で召喚してください。');
    return null;
  }
  return bot;
}

// ---------- コンパニオンボット ----------
function spawnBot(player) {
  try {
    const dim = player.dimension;
    const loc = player.location;
    const bot = dim.spawnEntity('minecraft:armor_stand', {
      x: loc.x + 1.5, y: loc.y, z: loc.z,
    });
    bot.addTag(BOT_TAG);
    bot.nameTag = BOT_NAME;
    const comp = bot.getComponent('minecraft:equippable');
    if (comp) {
      try { comp.setEquipment('head', new ItemStack('minecraft:carved_pumpkin')); } catch { }
    }
    bot.setCanBeShownNameOnly(false);
    botEntity = bot;
    tell(player, `${BOT_NAME} を召喚しました。`);
    hud(player, 'bot spawned');
  } catch (e) {
    tell(player, `ボット召喚に失敗しました: ${e}`);
  }
}

function dismissBot(player) {
  const bot = getBot();
  if (!bot) { tell(player, 'ボットは召喚されていません。'); return; }
  try { bot.remove(); } catch { }
  botEntity = null;
  followEnabled = false;
  followers.clear();
  tell(player, `${BOT_NAME} を消去しました。`);
  hud(player, 'bot dismissed');
}

function setFollow(player, on) {
  const bot = requireBot(player);
  if (!bot) return;
  followEnabled = !!on;
  followers.set(player.name, on);
  tell(player, on ? `${BOT_NAME} があなたを追従します。` : `${BOT_NAME} の追従を停止しました。`);
  hud(player, on ? 'follow: ON' : 'follow: OFF');
}

function comeHere(player) {
  const bot = requireBot(player);
  if (!bot) return;
  try {
    const loc = player.location;
    bot.teleport({ x: loc.x + 1, y: loc.y, z: loc.z }, { keepVelocity: false });
    tell(player, `${BOT_NAME} があなたのもとへ来ました。`);
    hud(player, 'bot: come');
  } catch (e) {
    tell(player, `テレポートに失敗しました: ${e}`);
  }
}

// 追従ループ: プレイヤーの2ブロック後ろにボットをテレポート
system.runInterval(() => {
  if (!followEnabled) return;
  try {
    const players = world.getPlayers();
    for (const [name, on] of followers) {
      if (!on) continue;
      const player = players.find(p => p.name === name);
      const bot = getBot();
      if (!player || !bot || !bot.isValid()) { followers.delete(name); continue; }
      if (player.dimension.id !== bot.dimension.id) continue;
      const loc = player.location;
      const rot = player.getRotation();
      const rad = (rot.y + 180) * Math.PI / 180;
      const tx = loc.x + Math.sin(rad) * -2;
      const tz = loc.z + Math.cos(rad) * -2;
      const dist = Math.hypot(bot.location.x - tx, bot.location.z - tz);
      if (dist > 1.2) {
        bot.teleport({ x: tx, y: loc.y, z: tz }, { keepVelocity: false });
      }
    }
  } catch { /* ignore */ }
}, 10);

// ---------- 建築（定型） ----------
function buildStructure(player, kind) {
  const p = player.location;
  const y = Math.floor(p.y);
  const d = player.dimension;
  const rot = player.getRotation();
  // プレイヤーの向いている方向の少し先に建てる
  const rad = (rot.y) * Math.PI / 180;
  const bx = Math.floor(p.x + Math.sin(rad) * 4);
  const bz = Math.floor(p.z + Math.cos(rad) * 4);

  const sets = [];
  const fill = (x1, y1, z1, x2, y2, z2, block) => sets.push(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`);
  const set = (x, yy, z, block) => sets.push(`setblock ${x} ${yy} ${z} ${block}`);

  const k = (kind || 'house').toLowerCase();
  if (k === 'tower' || k === '塔' || k === 'とう') {
    // 5x5x8 の塔
    for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
      const edge = dx === 0 || dx === 4 || dz === 0 || dz === 4;
      if (edge) fill(bx + dx, y, bz + dz, bx + dx, y + 7, bz + dz, 'minecraft:stone_bricks');
    }
    fill(bx, y + 8, bz, bx + 4, y + 8, bz + 4, 'minecraft:oak_planks');
    set(bx + 2, y + 9, bz + 2, 'minecraft:torch');
    fill(bx + 1, y + 1, bz + 1, bx + 3, y + 6, bz + 3, 'minecraft:air');
    set(bx + 2, y + 4, bz, 'minecraft:air');
  } else if (k === 'bridge' || k === '橋' || k === 'はし') {
    // 11x3 の橋
    fill(bx - 5, y, bz - 1, bx + 5, y, bz + 1, 'minecraft:oak_planks');
    for (let i = -5; i <= 5; i += 5) {
      fill(bx + i, y - 3, bz - 1, bx + i, y - 1, bz + 1, 'minecraft:oak_fence');
    }
    fill(bx - 5, y + 1, bz - 1, bx - 5, y + 1, bz + 1, 'minecraft:oak_fence_gate');
    fill(bx + 5, y + 1, bz - 1, bx + 5, y + 1, bz + 1, 'minecraft:oak_fence_gate');
  } else {
    // house / 家（デフォルト）
    fill(bx, y, bz, bx + 4, y, bz + 4, 'minecraft:oak_planks');
    fill(bx, y + 1, bz, bx + 4, y + 2, bz, 'minecraft:oak_planks');
    fill(bx, y + 1, bz + 4, bx + 4, y + 2, bz + 4, 'minecraft:oak_planks');
    fill(bx, y + 1, bz, bx, y + 2, bz + 4, 'minecraft:oak_planks');
    fill(bx + 4, y + 1, bz, bx + 4, y + 2, bz + 4, 'minecraft:oak_planks');
    fill(bx + 1, y + 3, bz + 1, bx + 3, y + 3, bz + 3, 'minecraft:air');
    set(bx + 2, y + 1, bz + 2, 'minecraft:crafting_table');
    set(bx + 2, y + 1, bz + 1, 'minecraft:torch');
    set(bx + 2, y + 4, bz + 2, 'minecraft:lantern');
  }

  let ok = 0;
  for (const c of sets) { if (run(player, c)) ok++; }
  const names = { house: '家', '家': '家', tower: '塔', '塔': '塔', bridge: '橋', '橋': '橋' };
  const label = names[k] || kind || '家';
  tell(player, `${label}を建築しました（${ok}/${sets.length} 操作）。座標: ${bx},${y},${bz}`);
  hud(player, `built: ${label}`);
}

// ---------- ステータス ----------
function showStatus(player) {
  const loc = player.location;
  const hp = player.getComponent('minecraft:health');
  const bot = getBot();
  tell(player, `時刻: ${world.getTimeOfDay()} / 天気: ${world.getWeather()}`);
  tell(player, `位置: ${loc.x.toFixed(1)}, ${loc.y.toFixed(1)}, ${loc.z.toFixed(1)} / HP: ${hp ? hp.currentValue : '?'} / ゲームモード: ${player.getGameMode()}`);
  tell(player, `ボット: ${bot && bot.isValid() ? `召喚済み${followEnabled ? '（追従中）' : ''}` : '未召喚'}`);
  hud(player, 'status');
}

// ---------- アイテム付与 ----------
const ITEM_ALIASES = {
  'ダイヤ': 'minecraft:diamond', 'diamond': 'minecraft:diamond',
  'エメラルド': 'minecraft:emerald', 'emerald': 'minecraft:emerald',
  '鉄': 'minecraft:iron_ingot', 'iron': 'minecraft:iron_ingot',
  '金': 'minecraft:gold_ingot', 'gold': 'minecraft:gold_ingot',
  'パン': 'minecraft:bread', 'bread': 'minecraft:bread',
  '骨': 'minecraft:bone', 'bone': 'minecraft:bone',
  '棒': 'minecraft:stick', 'stick': 'minecraft:stick',
  '松明': 'minecraft:torch', 'torch': 'minecraft:torch',
  '原木': 'minecraft:oak_log', 'log': 'minecraft:oak_log',
  'プランク': 'minecraft:oak_planks', 'planks': 'minecraft:oak_planks',
  'ガラス': 'minecraft:glass', 'glass': 'minecraft:glass',
  '丸石': 'minecraft:cobblestone', 'cobblestone': 'minecraft:cobblestone',
  '砂利': 'minecraft:gravel', 'gravel': 'minecraft:gravel',
};
function giveItem(player, itemArg, countArg) {
  const key = (itemArg || '').toLowerCase();
  const itemId = ITEM_ALIASES[key] || (key.includes(':') ? key : `minecraft:${key}`);
  const count = Math.min(64, Math.max(1, parseInt(countArg, 10) || 1));
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    if (!inv) { tell(player, 'インベントリが見つかりません。'); return; }
    let remaining = count;
    while (remaining > 0) {
      const n = Math.min(remaining, 64);
      const stack = new ItemStack(itemId, n);
      const left = inv.addItem(stack);
      if (left) { tell(player, 'インベントリがいっぱいです。'); break; }
      remaining -= n;
    }
    tell(player, `${itemId} x${count} を付与しました。`);
    hud(player, `give ${itemId}`);
  } catch {
    tell(player, `アイテム付与に失敗しました: ${itemArg}（!craftmate give diamond 16 のように指定してください）`);
  }
}

// ---------- コマンドディスパッチ ----------
const TIME_MAP = { day: 1000, 昼: 6000, noon: 6000, 朝: 1000, morning: 1000, night: 13000, 夜: 13000, midnight: 18000, 真夜中: 18000 };
const WEATHER_MAP = { clear: 'clear', 晴れ: 'clear', sun: 'clear', 快晴: 'clear', rain: 'rain', 雨: 'rain', thunder: 'thunder', 雷: 'thunder', 雷雨: 'thunder' };
const GAMEMODE_MAP = { survival: 0, s: 0, 0: 0, creative: 1, c: 1, 1: 1, adventure: 2, a: 2, 2: 2, spectator: 3, sp: 3, 3: 3 };
const DIFF_MAP = { peaceful: 'peaceful', ピースフル: 'peaceful', easy: 'easy', イージー: 'easy', normal: 'normal', ノーマル: 'normal', hard: 'hard', ハード: 'hard' };

async function handleCommand(player, args) {
  const cmd = (args[0] || 'help').toLowerCase();
  const rest = args.slice(1);
  const restStr = rest.join(' ');

  switch (cmd) {
    case 'help':
      tell(player, '【CraftMate コマンド】 !craftmate <command>');
      tell(player, 'status / say <文> / follow / stop / come / pos');
      tell(player, 'build <家|塔|橋|house|tower|bridge> / time <day|night> / weather <clear|rain|thunder>');
      tell(player, 'give <アイテム> <個数> / tp <x> <y> <z> / bot spawn|dismiss');
      tell(player, '日本語もOK: 「家建てて」「夜にして」「ここに来て」など。');
      hud(player, 'help');
      break;

    case 'status':
      showStatus(player);
      break;

    case 'say':
      if (!restStr) { tell(player, 'say <文> の形式で入力してください。'); usage(player); break; }
      world.sendMessage(`§d[CraftMate] ${player.name}: §f${restStr}`);
      hud(player, 'say');
      break;

    case 'follow':
      setFollow(player, true);
      break;

    case 'stop':
      setFollow(player, false);
      break;

    case 'come':
      comeHere(player);
      break;

    case 'build':
      if (!rest[0]) { tell(player, 'build <家|塔|橋|house|tower|bridge> を指定してください。'); usage(player); break; }
      buildStructure(player, rest[0]);
      break;

    case 'time': {
      const t = (rest[0] || '').toLowerCase();
      const v = TIME_MAP[t] ?? (/^\d+$/.test(t) ? Number(t) : null);
      if (v === null) { tell(player, 'time day|night|noon|midnight を指定してください。'); usage(player); break; }
      const ok = await run(player, `time set ${v}`);
      tell(player, ok ? `時刻を ${t} に設定しました。` : '時刻設定に失敗しました（コマンドが無効か権限がありません）。');
      hud(player, `time ${t}`);
      break;
    }

    case 'weather': {
      const w = (rest[0] || '').toLowerCase();
      const v = WEATHER_MAP[w];
      if (!v) { tell(player, 'weather clear|rain|thunder を指定してください。'); usage(player); break; }
      const ok = await run(player, `weather ${v}`);
      tell(player, ok ? `天気を ${v} に変更しました。` : '天気変更に失敗しました（権限がありません）。');
      hud(player, `weather ${v}`);
      break;
    }

    case 'give':
      if (!rest[0]) { tell(player, 'give <アイテム> <個数> を指定してください。例: give diamond 16'); usage(player); break; }
      giveItem(player, rest[0], rest[1]);
      break;

    case 'tp': {
      if (rest.length >= 3) {
        const [x, y, z] = rest.slice(0, 3).map(Number);
        if ([x, y, z].some(Number.isNaN)) { tell(player, 'tp <x> <y> <z> の形式で入力してください。'); usage(player); break; }
        player.teleport({ x, y, z });
        tell(player, `(${x}, ${y}, ${z}) にテレポートしました。`);
        hud(player, `tp ${x},${y},${z}`);
      } else if (rest[0]) {
        const target = world.getPlayers().find(p => p.name.toLowerCase() === rest[0].toLowerCase());
        if (!target) { tell(player, `プレイヤー ${rest[0]} が見つかりません。`); break; }
        player.teleport(target.location, { dimension: target.dimension });
        tell(player, `${target.name} のもとへテレポートしました。`);
        hud(player, `tp ${target.name}`);
      } else {
        tell(player, 'tp <x> <y> <z> または tp <プレイヤー名> を指定してください。');
        usage(player);
      }
      break;
    }

    case 'pos': {
      const loc = player.location;
      tell(player, `現在位置: ${loc.x.toFixed(1)}, ${loc.y.toFixed(1)}, ${loc.z.toFixed(1)}`);
      hud(player, 'pos');
      break;
    }

    case 'gamemode': {
      const g = (rest[0] || '').toLowerCase();
      if (!(g in GAMEMODE_MAP)) { tell(player, 'gamemode survival|creative|adventure|spectator を指定してください。'); usage(player); break; }
      const ok = await run(player, `gamemode ${GAMEMODE_MAP[g]} @s`);
      tell(player, ok ? 'ゲームモードを変更しました。' : 'ゲームモード変更に失敗しました（コマンドが無効か権限がありません）。');
      hud(player, `gamemode ${g}`);
      break;
    }

    case 'difficulty': {
      const d = (rest[0] || '').toLowerCase();
      const v = DIFF_MAP[d];
      if (!v) { tell(player, 'difficulty peaceful|easy|normal|hard を指定してください。'); usage(player); break; }
      const ok = await run(player, `difficulty ${v}`);
      tell(player, ok ? `難易度を ${v} に変更しました。` : '難易度変更に失敗しました（権限がありません）。');
      hud(player, `difficulty ${v}`);
      break;
    }

    case 'bot': {
      const sub = (rest[0] || 'help').toLowerCase();
      if (sub === 'spawn' || sub === '召喚') spawnBot(player);
      else if (sub === 'dismiss' || sub === '消して' || sub === '消去') dismissBot(player);
      else if (sub === 'follow' || sub === '追従') setFollow(player, true);
      else if (sub === 'come' || sub === 'こい') comeHere(player);
      else if (sub === 'stop' || sub === '止まれ' || sub === '待て') setFollow(player, false);
      else tell(player, 'bot spawn|follow|come|stop|dismiss を指定してください。');
      break;
    }

    default:
      tell(player, `不明なコマンド: ${cmd}`);
      usage(player);
  }
}

// ---------- 日本語自然言語インテント ----------
function handleNatural(player, text) {
  const t = text;
  if (/家|建物|建築|小屋/.test(t) && /建て|作って|欲しい/.test(t)) return 'build:' + (/塔/.test(t) ? 'tower' : /橋/.test(t) ? 'bridge' : 'house');
  if (/止まれ|待て|止まって/.test(t)) return 'stop';
  if (/ついてきて|追従|ついて/.test(t)) return 'follow';
  if (/こっち|ここ|来て/.test(t)) return 'come';
  if (/消えて|消して|消去/.test(t)) return 'bot:dismiss';
  if (/こんにちは|やあ|おはよう|こんばんは/.test(t)) return 'say:こんにちは！「!craftmate help」でコマンド一覧を見られます。';
  const timeMatch = t.match(/(朝|昼|夜|真夜中)にして|時間.*(朝|昼|夜|真夜中)/);
  if (timeMatch) {
    const word = timeMatch[1] || timeMatch[2];
    return 'time:' + word;
  }
  if (/雨.*降らせ|雨にして/.test(t)) return 'weather:rain';
  if (/雷雨|雷.*降らせ/.test(t)) return 'weather:thunder';
  if (/晴れ|快晴/.test(t)) return 'weather:clear';
  return null;
}

async function dispatch(player, intent) {
  if (intent.startsWith('build:')) return handleCommand(player, ['build', intent.slice(6)]);
  if (intent.startsWith('time:')) return handleCommand(player, ['time', intent.slice(5)]);
  if (intent.startsWith('weather:')) return handleCommand(player, ['weather', intent.slice(8)]);
  if (intent.startsWith('say:')) return handleCommand(player, ['say', intent.slice(4)]);
  if (intent.startsWith('bot:')) return handleCommand(player, ['bot', intent.slice(4)]);
  return handleCommand(player, [intent]);
}

// ---------- カスタムコマンド登録（/craftmate:* 形式） ----------
// Minecraft 1.20.10+ の customCommandRegistry を使用。
// スラッシュコマンドは chatSend では傍受できないため、こちらで正式に登録する。
// さらに /scriptevent craftmate:* 経由でも同じコマンドを実行できる（フォールバック）。

const COMMAND_DEFS = [
  { name: 'help', desc: 'コマンド一覧を表示', args: [] },
  { name: 'status', desc: 'ボット・プレイヤーの状態を表示', args: [] },
  { name: 'say', desc: 'ボットがチャットで発言', args: [{ name: 'message', type: 'string', optional: false }] },
  { name: 'follow', desc: 'ボットがプレイヤーに追従', args: [] },
  { name: 'stop', desc: '追従を停止', args: [] },
  { name: 'come', desc: 'ボットをプレイヤーの位置へテレポート', args: [] },
  { name: 'build', desc: '定型建築（家/塔/橋）', args: [{ name: 'kind', type: 'string', optional: true }] },
  { name: 'time', desc: '時間変更（day/night/noon/midnight）', args: [{ name: 'value', type: 'string', optional: false }] },
  { name: 'weather', desc: '天気変更（clear/rain/thunder）', args: [{ name: 'value', type: 'string', optional: false }] },
  { name: 'give', desc: 'アイテム付与', args: [{ name: 'item', type: 'string', optional: false }, { name: 'count', type: 'integer', optional: true }] },
  { name: 'tp', desc: '座標へテレポート', args: [{ name: 'x', type: 'integer', optional: false }, { name: 'y', type: 'integer', optional: false }, { name: 'z', type: 'integer', optional: false }] },
  { name: 'pos', desc: '現在位置を表示', args: [] },
  { name: 'gamemode', desc: 'ゲームモード変更', args: [{ name: 'mode', type: 'string', optional: false }] },
  { name: 'difficulty', desc: '難易度変更', args: [{ name: 'level', type: 'string', optional: false }] },
  { name: 'bot', desc: 'ボット操作（spawn/follow/come/stop/dismiss）', args: [{ name: 'action', type: 'string', optional: true }] },
];

// scriptevent / カスタムコマンド共通のエントリポイント
async function runSlashCommand(playerLike, cmdName, rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  await handleCommand(playerLike, [cmdName, ...args]);
}

function registerCustomCommands(startupEvent) {
  const registry = startupEvent.customCommandRegistry;
  if (!registry || typeof registry.registerCommand !== 'function') {
    console.warn('[CraftMate] customCommandRegistry unavailable; /craftmate:* disabled (use !craftmate in chat or /scriptevent craftmate:*)');
    return;
  }
  for (const def of COMMAND_DEFS) {
    try {
      const registration = {
        name: `craftmate:${def.name}`,
        description: def.desc,
        permissionLevel: CommandPermissionLevel.Any,
      };
      // パラメータ定義（対応バージョンのみ）
      if (def.args.length) {
        const mandatory = def.args.filter(a => !a.optional).map(a => ({ name: a.name, type: a.type }));
        const optional = def.args.filter(a => a.optional).map(a => ({ name: a.name, type: a.type }));
        if (mandatory.length) registration.mandatoryParameters = mandatory;
        if (optional.length) registration.optionalParameters = optional;
      }
      registry.registerCommand(registration, async (origin) => {
        try {
          const source = origin && origin.sourceEntity;
          if (!source) return { status: CustomCommandStatus.Failure };
          const params = origin.params || {};
          const ordered = def.args.map(a => params[a.name]);
          // 未指定の必須引数があれば失敗
          if (def.args.some((a, i) => !a.optional && ordered[i] === undefined)) {
            return { status: CustomCommandStatus.Failure };
          }
          await runSlashCommand(source, def.name, ordered.filter(v => v !== undefined));
          return { status: CustomCommandStatus.Success };
        } catch (e) {
          try { origin && origin.sourceEntity && origin.sourceEntity.sendMessage(`§c[CraftMate] エラー: ${e}`); } catch { }
          return { status: CustomCommandStatus.Failure };
        }
      });
    } catch (e) {
      console.warn(`[CraftMate] failed to register craftmate:${def.name}: ${e}`);
    }
  }
  console.log('[CraftMate] custom commands registered: /craftmate:<cmd>');
}

// ---------- チャット受信 ----------
system.beforeEvents.startup.subscribe((event) => {
  // カスタムコマンド（/craftmate:help 等）を登録
  try { registerCustomCommands(event); } catch (e) { console.warn('[CraftMate] customCommandRegistry error:', e); }

  world.beforeEvents.chatSend.subscribe(async (event) => {
    try {
      const msg = event.message.trim();
      const lower = msg.toLowerCase();

      // プレフィックス解析: "!craftmate ..." / "craftmate ..." / "!cm ..." / "cm ..."
      // 大文字小文字を区別しない。"!" は任意。
      const m = msg.match(/^!?\s*(craftmate|cm|クラフトメイト)\b[\s:：]*(.*)$/i);
      if (m) {
        const rest = (m[2] || '').trim();
        const args = rest ? rest.split(/\s+/) : ['help'];
        event.cancel = true;
        await handleCommand(event.sender, args);
        return;
      }

      // プレフィックスなしの日本語自然言語（craftmate を含む発言のみ）
      if (/craftmate|クラフトメイト/i.test(msg)) {
        const intent = handleNatural(event.sender, msg);
        if (intent !== null) {
          event.cancel = true;
          await dispatch(event.sender, intent);
        }
      }
    } catch (e) {
      try {
        event.sender.sendMessage(`§c[CraftMate] エラー: ${e && e.message ? e.message : e}`);
        usage(event.sender);
      } catch { /* ignore */ }
    }
  });

  // /scriptevent craftmate:<cmd> [args...] フォールバック
  // カスタムコマンドが使えない環境でも /scriptevent 経由で同じコマンドを実行できる。
  // 例: /scriptevent craftmate:run help   /scriptevent craftmate:status
  system.afterEvents.scriptEventReceive.subscribe((ev) => {
    try {
      const id = String(ev.messageId || '');
      if (!id.toLowerCase().startsWith('craftmate:')) return;
      const source = ev.sourceEntity;
      if (!source) return;
      const sub = id.slice('craftmate:'.length).toLowerCase();
      const msgArgs = String(ev.message || '').trim();
      let cmdName, cmdArgs;
      if (sub === 'run' || sub === '') {
        // /scriptevent craftmate:run <cmd> [args...]
        const parts = msgArgs.split(/\s+/).filter(Boolean);
        cmdName = parts[0] || 'help';
        cmdArgs = parts.slice(1);
      } else {
        // /scriptevent craftmate:<cmd> [args...]
        cmdName = sub;
        cmdArgs = msgArgs ? msgArgs.split(/\s+/) : [];
      }
      runSlashCommand(source, cmdName, cmdArgs);
    } catch (e) {
      console.warn('[CraftMate] scriptevent error:', e);
    }
  });

  world.sendMessage('§a[CraftMate Bedrock] §fアドオンが有効化されました。/craftmate:help またはチャットで「!craftmate help」と入力してください。');
});
