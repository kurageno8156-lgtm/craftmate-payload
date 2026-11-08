import { ToolDefinition, ToolCallResult } from '../types.js';
import { MinecraftBot } from '../bot/mcBot.js';
import type { LLMClient } from './llmClient.js';

const DANGEROUS_COMMANDS = new Set(['kill', 'ban', 'ban-ip', 'banlist', 'op', 'deop', 'kick', 'stop', 'whitelist', 'pardon', 'setblock', 'fill', 'clone', 'function', 'give', 'clear']);

export const BOT_TOOLS: ToolDefinition[] = [
  {
    name: 'chat',
    description: 'Minecraft内のプレイヤーに向けてチャットメッセージを発言・報告します。タスクの進捗状況や質問、完了報告などに使います。',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '発言するメッセージ内容（日本語で簡潔に）',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'goToPlayer',
    description: '指定した名前のプレイヤーの近く（2m以内）まで自動で歩いて移動します。',
    parameters: {
      type: 'object',
      properties: {
        playerName: {
          type: 'string',
          description: '移動先となるプレイヤーのユーザー名',
        },
      },
      required: ['playerName'],
    },
  },
  {
    name: 'goToCoordinates',
    description: '指定した座標(X, Y, Z)の近くまで自動で歩いて移動します。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目標地点のX座標' },
        y: { type: 'number', description: '目標地点のY座標' },
        z: { type: 'number', description: '目標地点のZ座標' },
        range: { type: 'number', description: '目標地点への許容誤差距離（デフォルト: 1）' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'followPlayer',
    description: '指定したプレイヤーの背後を継続して追従・ついて歩きます。',
    parameters: {
      type: 'object',
      properties: {
        playerName: {
          type: 'string',
          description: '追従するプレイヤーのユーザー名',
        },
      },
      required: ['playerName'],
    },
  },
  {
    name: 'mineAndCollect',
    description: '周囲にある指定されたブロック（木、原木、丸石、鉄鉱石、砂利など）を探索し、採掘して落ちたアイテムを回収します。',
    parameters: {
      type: 'object',
      properties: {
        blockName: {
          type: 'string',
          description: '採掘したいブロック名（例: "oak_log", "wood", "stone", "iron_ore", "coal_ore", "dirt" など）',
        },
        count: {
          type: 'number',
          description: '採掘したい個数（デフォルト: 1）',
        },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'craftItem',
    description: '指定したアイテムをクラフト（作成）します。3x3レシピの場合は近くに作業台が必要です。',
    parameters: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'クラフトしたいアイテム名（例: "oak_planks", "stick", "crafting_table", "wooden_pickaxe", "iron_sword" 等）',
        },
        count: {
          type: 'number',
          description: 'クラフトする回数（デフォルト: 1）',
        },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'placeCommandBlock',
    description: '指定座標にコマンドブロックを設置し、コマンドと種類を設定する（クリエイティブ必須）',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '設置するX座標' },
        y: { type: 'number', description: '設置するY座標' },
        z: { type: 'number', description: '設置するZ座標' },
        command: { type: 'string', description: '実行するMinecraftコマンド（例: time set day）' },
        commandType: { type: 'string', enum: ['impulse', 'chain', 'repeat'], description: 'コマンドブロックの種類（省略時はimpulse）' },
      },
      required: ['x', 'y', 'z', 'command'],
    },
  },
  {
    name: 'generateArchitecturalBlueprint',
    description: '建物の詳細な設計図をAIが生成する。家具・庭・照明まで含むプロ級の設計図JSONを作成し、buildBlueprintで建築できる',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '建物の説明（例: モダンな2階建ての家、庭付き、池付き）' },
        size: { type: 'string', description: '建物のサイズ感（例: 小さめ/標準/大きめ、または具体的な寸法）' },
      },
      required: ['description'],
    },
  },
  {
    name: 'buildBlueprint',
    description: 'generateArchitecturalBlueprintで生成した設計図をBotの足元を原点として実際に建築する',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getCommandBlockHistory',
    description: 'コマンドブロックの実行履歴（直近10件）を取得する。前回の実行結果・成否・時刻を確認したい時に使う',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '取得件数（最大10、省略時10）' },
      },
      required: [],
    },
  },
  {
    name: 'triggerCommandBlock',
    description: '設置済みのコマンドブロックにレッドストーンパルスを送り発動させる',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'コマンドブロックのX座標' },
        y: { type: 'number', description: 'コマンドブロックのY座標' },
        z: { type: 'number', description: 'コマンドブロックのZ座標' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'placeBlock',
    description: 'インベントリにある指定ブロックを足元または指定座標に設置します。',
    parameters: {
      type: 'object',
      properties: {
        blockName: {
          type: 'string',
          description: '設置したいブロック名（例: "crafting_table", "cobblestone", "dirt", "torch" など）',
        },
        x: { type: 'number', description: '設置先のX座標（省略時は目の前）' },
        y: { type: 'number', description: '設置先のY座標（省略時は目の前）' },
        z: { type: 'number', description: '設置先のZ座標（省略時は目の前）' },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'huntMob',
    description: '周囲24ブロック以内の牛・豚・鶏・羊・ウサギ・ヤギ、または一般的な敵対Mobを探して武器で倒し、近くに落ちたアイテムを回収します。「狩りをして」「食料用に動物を狩って」などの指示に使います。最大5体まで狩り、体力が少ない場合は安全のため中断します。',
    parameters: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['animals', 'hostiles', 'any'],
          description: '狩る対象。動物だけなら animals、敵対Mobだけなら hostiles、両方なら any。',
        },
        maxTargets: { type: 'number', description: '倒す最大数（1〜5、既定値3）' },
      },
    },
  },
  {
    name: 'attackTarget',
    description: '指定した名前のMob（例: "zombie", "skeleton", "spider"）や対象を攻撃します。',
    parameters: {
      type: 'object',
      properties: {
        targetName: {
          type: 'string',
          description: '攻撃するMob名またはターゲット（例: "zombie", "skeleton", "creeper" 等）',
        },
      },
      required: ['targetName'],
    },
  },
  {
    name: 'giveItemsToPlayer',
    description: 'プレイヤーの元へ移動し、インベントリ内の指定アイテムを投げ渡します。',
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: '渡す相手のプレイヤー名' },
        itemName: { type: 'string', description: '渡すアイテム名（例: "oak_log", "apple", "iron_ingot"）' },
        count: { type: 'number', description: '渡す個数（デフォルト: 1）' },
      },
      required: ['playerName', 'itemName'],
    },
  },
  {
    name: 'dropItem',
    description: 'インベントリ内の不要なアイテムをその場に捨てます。',
    parameters: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '捨てるアイテム名' },
        count: { type: 'number', description: '捨てる個数（デフォルト: 1）' },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'equipItem',
    description: 'インベントリ内の武器や防具、道具を装備します。',
    parameters: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '装備したいアイテム名（例: "iron_sword", "diamond_chestplate"）' },
        destination: {
          type: 'string',
          enum: ['hand', 'head', 'torso', 'legs', 'feet'],
          description: '装備するスロット（手、頭、胴体、脚、足）',
        },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'executeCommand',
    description: 'Minecraftのスラッシュコマンドを実行します（例: /time set day、/tp、/give）。「昼にして」「テレポートして」などの指示に使います。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '実行するMinecraftコマンド。先頭の / は省略可（例: "time set day" または "/time set day"）',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'stopActions',
    description: '現在進行中のすべての移動、追従、採掘、攻撃などのアクションを停止します。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'finishTask',
    description: '最新の環境・インベントリで指示された目標全体の達成を確認できた場合だけ呼び出します。資材不足、道具不足、失敗、進捗報告、または一時的に行動できないことを理由に呼び出してはいけません。必要な素材を採掘・収集し、クラフトや別の手段を続けてください。',
    parameters: {
      type: 'object',
      properties: {
        resultSummary: {
          type: 'string',
          description: '完了したタスクのまとめや結果報告',
        },
      },
      required: ['resultSummary'],
    },
  },
];

// LLMが省略可能な数値引数を null で返すことがあるため、有限の数値のみを通す
function toFiniteNumber(value: any): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toCount(value: any, fallback: number = 1): number {
  const n = toFiniteNumber(value);
  return n !== undefined && n > 0 ? Math.floor(n) : fallback;
}

export async function executeBotTool(
  botWrapper: MinecraftBot,
  toolName: string,
  args: Record<string, any>,
  llmClient?: LLMClient
): Promise<ToolCallResult> {
  const skills = botWrapper.skills;
  if (!skills) {
    return { success: false, message: 'Botのスキルモジュールが準備できていません。' };
  }

  try {
    switch (toolName) {
      case 'chat':
        return await skills.chat(args.message);
      case 'goToPlayer':
        return await skills.goToPlayer(args.playerName);
      case 'goToCoordinates': {
        const x = toFiniteNumber(args.x);
        const y = toFiniteNumber(args.y);
        const z = toFiniteNumber(args.z);
        if (x === undefined || y === undefined || z === undefined) {
          return { success: false, message: '座標(x, y, z)には有効な数値が必要です。整数の座標を指定してください。' };
        }
        return await skills.goToCoordinates(x, y, z, toFiniteNumber(args.range));
      }
      case 'followPlayer':
        return await skills.followPlayer(args.playerName);
      case 'mineAndCollect':
        return await skills.mineAndCollect(args.blockName, toCount(args.count));
      case 'craftItem':
        return await skills.craftItem(args.itemName, toCount(args.count));
      case 'placeBlock': {
        const px = toFiniteNumber(args.x);
        const py = toFiniteNumber(args.y);
        const pz = toFiniteNumber(args.z);
        const hasCoords = px !== undefined && py !== undefined && pz !== undefined;
        const hasPartialCoords = (px !== undefined || py !== undefined || pz !== undefined) && !hasCoords;
        if (hasPartialCoords) {
          return { success: false, message: '設置座標は x, y, z をすべて指定するか、すべて省略してください。' };
        }
        return await skills.placeBlock(args.blockName, hasCoords ? px : undefined, hasCoords ? py : undefined, hasCoords ? pz : undefined);
      }
      case 'attackTarget':
        return await skills.attackTarget(args.targetName);
      case 'huntMob':
        return await skills.huntMob(toCount(args.maxTargets, 3), args.targetType || 'any');
      case 'giveItemsToPlayer':
        return await skills.giveItemsToPlayer(args.playerName, args.itemName, toCount(args.count));
      case 'dropItem':
        return await skills.dropItem(args.itemName, toCount(args.count));
      case 'equipItem':
        return await skills.equipItem(args.itemName, args.destination || 'hand');
      case 'executeCommand': {
        const cfg = botWrapper.config as any;
        if (cfg.botAllowCommands === false) {
          return { success: false, message: '管理者設定でコマンド実行が無効になっています。' };
        }
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!command) {
          return { success: false, message: 'コマンドが指定されていません。' };
        }
        const normalized = command.startsWith('/') ? command.slice(1) : command;
        const head = normalized.split(/\s+/)[0].toLowerCase();
        if (DANGEROUS_COMMANDS.has(head) && cfg.botAllowDangerousCommands === false) {
          return { success: false, message: `管理者設定で危険なコマンド (/ ${head}) が禁止されています。` };
        }
        return await skills.executeCommand(command);
      }
      case 'placeCommandBlock': {
        const cfg = botWrapper.config as any;
        if (cfg.botAllowCommands === false) {
          return { success: false, message: '管理者設定でコマンド実行が無効になっています。' };
        }
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        if (![x, y, z].every(Number.isFinite)) {
          return { success: false, message: '座標が不正です。x/y/zは数値で指定してください。' };
        }
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!command) {
          return { success: false, message: 'コマンドが指定されていません。' };
        }
        const normalized = command.startsWith('/') ? command.slice(1) : command;
        const head = normalized.split(/\s+/)[0].toLowerCase();
        if (DANGEROUS_COMMANDS.has(head) && cfg.botAllowDangerousCommands === false) {
          return { success: false, message: `管理者設定で危険なコマンド (/ ${head}) を含むコマンドブロックが禁止されています。` };
        }
        const commandType = args.commandType === 'chain' || args.commandType === 'repeat' ? args.commandType : 'impulse';
        return await skills.placeCommandBlock(x, y, z, command, commandType);
      }
      case 'generateArchitecturalBlueprint': {
        if (!llmClient) return { success: false, message: '設計図生成にはAI接続が必要です。' };
        const description = typeof args.description === 'string' ? args.description.trim() : '';
        if (!description) return { success: false, message: '建物の説明を指定してください。' };
        const size = typeof args.size === 'string' ? args.size.trim() : '標準';
        const prompt =
          `あなたはMinecraft建築のプロです。「${description}」（サイズ: ${size}）の詳細な設計図をJSONのみで出力してください。\n` +
          `ブロックは必ずMinecraftの英語ID（例: stone_bricks, oak_planks, glass, oak_stairs, oak_door, torch, lantern, water, grass_block, oak_leaves）を使ってください。\n` +
          `以下の形式で、合計400ブロック以内に収めてください:\n` +
          `{"name":"名前","size":{"x":10,"y":6,"z":10},"structure":{"foundation":[{"x":0,"y":0,"z":0,"block":"stone_bricks"}],"walls":[],"roof":[],"windows":[],"doors":[],"decorations":[],"garden":[],"lighting":[]}}\n` +
          `基礎・壁・屋根・窓・ドア・装飾・庭・照明を全て含め、プロ級の見栄えになるよう設計してください。説明文は不要、JSONのみ出力。`;
        let raw = '';
        try {
          raw = await llmClient.chatOnce(prompt);
        } catch (err: any) {
          return { success: false, message: `設計図生成エラー: ${err.message}` };
        }
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { success: false, message: '設計図のJSONを生成できませんでした。' };
        let bp: any;
        try { bp = JSON.parse(jsonMatch[0]); } catch {
          return { success: false, message: '設計図JSONの解析に失敗しました。' };
        }
        if (!bp.structure || typeof bp.structure !== 'object') {
          return { success: false, message: '設計図の構造が不正です。' };
        }
        skills.pendingBlueprint = bp;
        const counts: Record<string, number> = {};
        for (const [k, v] of Object.entries(bp.structure)) counts[k] = Array.isArray(v) ? v.length : 0;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        return { success: true, message: `設計図「${bp.name || description}」を生成しました（${total}ブロック: ${JSON.stringify(counts)}）。buildBlueprint で建築できます。` };
      }
      case 'buildBlueprint':
        return await skills.buildBlueprint();
      case 'getCommandBlockHistory': {
        const limit = toCount(args.limit, 10);
        const history = skills.getCommandBlockHistory(limit);
        return {
          success: true,
          message: history.length > 0
            ? `コマンドブロック履歴（最新${history.length}件）: ${JSON.stringify(history)}`
            : 'コマンドブロックの実行履歴はまだありません。',
        };
      }
      case 'triggerCommandBlock': {
        const cfg = botWrapper.config as any;
        if (cfg.botAllowCommands === false) {
          return { success: false, message: '管理者設定でコマンド実行が無効になっています。' };
        }
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        if (![x, y, z].every(Number.isFinite)) {
          return { success: false, message: '座標が不正です。x/y/zは数値で指定してください。' };
        }
        return await skills.triggerCommandBlock(x, y, z);
      }
      case 'stopActions':
        return await skills.stopActions();
      case 'finishTask':
        return { success: true, message: `タスク完了: ${args.resultSummary}` };
      default:
        return { success: false, message: `未知のツールです: ${toolName}` };
    }
  } catch (err: any) {
    return { success: false, message: `ツール実行エラー (${toolName}): ${err.message}` };
  }
}
