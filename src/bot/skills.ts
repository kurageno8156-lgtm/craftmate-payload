import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolCallResult } from '../types.js';
import pkgPathfinder from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';

const { goals, Movements } = pkgPathfinder;
const HUNTABLE_ANIMALS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'goat']);
const HUNTABLE_HOSTILES = new Set(['zombie', 'skeleton', 'spider', 'cave_spider', 'drowned', 'husk', 'stray', 'slime', 'silverfish', 'phantom', 'pillager']);


/**
 * タイムアウト付きPromise実行ヘルパー
 */
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMsg));
    }, ms);
  });

  return Promise.race([
    promise.then(res => {
      clearTimeout(timeoutId);
      return res;
    }),
    timeoutPromise,
  ]);
}

export class SkillManager {
  private bot: Bot;
  public guard: { isInCombat(): boolean } | null = null;
  private mcData: any;
  private mcDataVersion: string | null = null;
  private isFollowing: boolean = false;
  private followTarget: string | null = null;
  private followInterval: NodeJS.Timeout | null = null;
  private commandBlockHistory: Array<{ timestamp: string; x: number; y: number; z: number; command: string; success: boolean; output: string; }> = [];

  private recordCommandBlock(x: number, y: number, z: number, command: string, success: boolean, output: string) {
    this.commandBlockHistory.push({
      timestamp: new Date().toISOString(),
      x, y, z,
      command: command || '',
      success,
      output: output || '',
    });
    if (this.commandBlockHistory.length > 10) {
      this.commandBlockHistory = this.commandBlockHistory.slice(-10);
    }
  }

  public getCommandBlockHistory(limit = 10): typeof this.commandBlockHistory {
    return this.commandBlockHistory.slice(-Math.max(1, Math.min(limit, 10)));
  }

  // ---- 建築設計図 ----
  public pendingBlueprint: any = null;
  public blueprintProgress: ((message: string) => void) | null = null;

  /**
   * クリエイティブモードでなければ /gamemode creative を試行する。
   */
  private async ensureCreativeMode(): Promise<boolean> {
    if (this.bot.player.gamemode === 1) return true;
    try {
      this.bot.chat('/gamemode creative @s');
      await new Promise(r => setTimeout(r, 1200));
      if (this.bot.player.gamemode === 1) return true;
      this.bot.chat('/gamemode creative');
      await new Promise(r => setTimeout(r, 1200));
      return this.bot.player.gamemode === 1;
    } catch { return false; }
  }

  /**
   * 設計図JSONをBot足元を原点として建築する（クリエイティブモード推奨）。
   * structure 内の各セクション配列 {x,y,z,block} を順に設置する。
   */
  public async buildBlueprint(): Promise<ToolCallResult> {
    const bp = this.pendingBlueprint;
    if (!bp || !bp.structure) {
      return { success: false, message: '設計図がありません。先に generateArchitecturalBlueprint を実行してください。' };
    }
    const base = this.bot.entity.position.floored();
    const entries: Array<{ x: number; y: number; z: number; block: string; section: string }> = [];
    for (const [section, list] of Object.entries(bp.structure as Record<string, any[]>)) {
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (e && typeof e.block === 'string' && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)) {
          entries.push({ x: base.x + e.x, y: base.y + e.y, z: base.z + e.z, block: e.block, section });
        }
      }
    }
    if (entries.length === 0) {
      return { success: false, message: '設計図に設置可能なブロックがありません。' };
    }
    if (entries.length > 1500) {
      return { success: false, message: `設計図のブロック数が多すぎます（${entries.length}個、上限1500）。もっとコンパクトな設計にしてください。` };
    }
    if (!(await this.ensureCreativeMode())) {
      return { success: false, message: '手作業での建築にはクリエイティブモードが必要です（アイテムが無いため設置できません）。コマンドブロック建築もクリエイティブモードが必要です。サーバーで /gamemode creative を実行する権限があるか確認してください。' };
    }
    let placed = 0;
    let failed = 0;
    const itemCache = new Map<string, any>();
    for (const entry of entries) {
      try {
        const target = new Vec3(Math.floor(entry.x), Math.floor(entry.y), Math.floor(entry.z));
        const existing = this.bot.blockAt(target);
        if (existing && existing.name === entry.block) { placed++; continue; }
        // アイテムをホットバーにセット
        let item = itemCache.get(entry.block);
        if (!item) {
          await this.bot.creative.setInventorySlot(36, { name: entry.block, count: 64 } as any);
          item = this.bot.inventory.items().find(i => i.name === entry.block);
          if (item) itemCache.set(entry.block, item);
        }
        if (!item) { failed++; continue; }
        try { await this.bot.equip(item, 'hand'); } catch { /* 次へ */ }
        // 隣接する固体ブロックを基準に設置
        const dirs = [
          { off: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
          { off: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
          { off: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
          { off: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
          { off: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
          { off: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
        ];
        let done = false;
        let failReason = 'no solid neighbor';
        for (const d of dirs) {
          const ref = this.bot.blockAt(target.plus(d.off));
          if (!ref || ref.name === 'air' || ref.name === 'cave_air' || ref.name === 'void_air') continue;
          try {
            await this.bot.placeBlock(ref, d.face);
            done = true;
            break;
          } catch (e: any) { failReason = e?.message || 'placeBlock failed'; }
        }
        // 隣接ブロックが全くない場合: 足場（dirt）を下に仮設置してから再試行
        if (!done) {
          try {
            const below = this.bot.blockAt(target.offset(0, -1, 0));
            if (below && (below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air')) {
              await this.bot.creative.setInventorySlot(36, { name: 'dirt', count: 64 } as any);
              const dirtItem = this.bot.inventory.items().find(i => i.name === 'dirt');
              if (dirtItem) {
                await this.bot.equip(dirtItem, 'hand');
                const belowRef = this.bot.blockAt(target.offset(0, -2, 0));
                if (belowRef && belowRef.name !== 'air') {
                  await this.bot.placeBlock(belowRef, new Vec3(0, 1, 0));
                  await new Promise(r => setTimeout(r, 150));
                  const newBelow = this.bot.blockAt(target.offset(0, -1, 0));
                  if (newBelow && newBelow.name !== 'air') {
                    await this.bot.placeBlock(newBelow, new Vec3(0, 1, 0));
                    done = true;
                  }
                }
              }
            }
          } catch { /* 足場失敗は無視 */ }
        }
        if (done) placed++;
        else {
          failed++;
          if (failed <= 10) console.warn(`[Build] Failed to place ${entry.block} at (${entry.x},${entry.y},${entry.z}): ${failReason}`);
        }
      } catch { failed++; }
      if (placed % 50 === 0 && placed > 0) {
        try { this.blueprintProgress?.(`建築中... ${placed}/${entries.length} ブロック設置済み`); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    const name = bp.name || '設計図';
    return {
      success: failed === 0 || placed > 0,
      message: `${name} の建築が完了しました（設置 ${placed} 個 / 失敗 ${failed} 個 / 合計 ${entries.length} 個）。`,
    };
  }

  constructor(bot: Bot) {
    this.bot = bot;
    this.bot.once('spawn', () => {
      this.getMCData();
    });
  }

  private getMCData() {
    const detectedVersion = this.bot.version;
    if (!detectedVersion) return null;
    if (this.mcDataVersion === detectedVersion) return this.mcData || null;
    this.mcDataVersion = detectedVersion;
    try {
      this.mcData = minecraftData(detectedVersion);
    } catch (error) {
      this.mcData = null;
      console.warn(`[Bot] minecraft-data has no definitions for detected Minecraft ${detectedVersion}:`, error);
    }
    return this.mcData;
  }

  private getMovements(): any {
    const movements = new Movements(this.bot);
    movements.canDig = true;
    movements.allow1by1towers = false;
    movements.maxDropDown = 4;
    return movements;
  }

  /**
   * チャット発言
   */
  public async chat(message: string): Promise<ToolCallResult> {
    // AutoGuardが敵と戦闘中はチャット送信を一時停止する
    if (this.guard && this.guard.isInCombat()) {
      return { success: false, message: 'AutoGuardが敵と戦闘中のため、チャットは送信されませんでした。' };
    }
    try {
      this.bot.chat(message);
      return { success: true, message: `チャット発言: "${message}"` };
    } catch (err: any) {
      return { success: false, message: `チャット送信エラー: ${err.message}` };
    }
  }

  /**
   * 指定プレイヤーの元へ移動
   */
  public async goToPlayer(playerName: string): Promise<ToolCallResult> {
    this.stopFollowing();
    const targetPlayer = this.bot.players[playerName]?.entity;
    if (!targetPlayer) {
      return {
        success: false,
        message: `プレイヤー "${playerName}" が見つかりません。近くにいるか確認してください。`,
      };
    }

    try {
      const movements = this.getMovements();
      this.bot.pathfinder.setMovements(movements);
      const goal = new goals.GoalNear(
        targetPlayer.position.x,
        targetPlayer.position.y,
        targetPlayer.position.z,
        2
      );
      await withTimeout(this.bot.pathfinder.goto(goal), 20000, `プレイヤー "${playerName}" への移動がタイムアウトしました。`);
      return {
        success: true,
        message: `プレイヤー "${playerName}" の位置 (${Math.round(targetPlayer.position.x)}, ${Math.round(targetPlayer.position.y)}, ${Math.round(targetPlayer.position.z)}) に到着しました。`,
      };
    } catch (err: any) {
      this.bot.pathfinder.stop();
      return {
        success: false,
        message: `プレイヤー "${playerName}" への移動中にエラーが発生しました: ${err.message}`,
      };
    }
  }

  /**
   * 指定座標へ移動
   */
  public async goToCoordinates(x: number, y: number, z: number, range: number = 1): Promise<ToolCallResult> {
    this.stopFollowing();
    try {
      const movements = this.getMovements();
      this.bot.pathfinder.setMovements(movements);
      const goal = new goals.GoalNear(x, y, z, Math.max(1, range));
      await withTimeout(this.bot.pathfinder.goto(goal), 20000, `座標 (${x}, ${y}, ${z}) への移動がタイムアウトしました。`);
      return {
        success: true,
        message: `指定座標 (${x}, ${y}, ${z}) の近くに到着しました。現在地: (${Math.round(this.bot.entity.position.x)}, ${Math.round(this.bot.entity.position.y)}, ${Math.round(this.bot.entity.position.z)})`,
      };
    } catch (err: any) {
      this.bot.pathfinder.stop();
      return {
        success: false,
        message: `座標 (${x}, ${y}, ${z}) への移動に失敗しました: ${err.message}`,
      };
    }
  }

  /**
   * プレイヤーを追従開始
   */
  public async followPlayer(playerName: string): Promise<ToolCallResult> {
    this.stopFollowing();
    const targetPlayer = this.bot.players[playerName]?.entity;
    if (!targetPlayer) {
      return {
        success: false,
        message: `プレイヤー "${playerName}" が見つかりません。`,
      };
    }

    this.isFollowing = true;
    this.followTarget = playerName;

    const movements = this.getMovements();
    this.bot.pathfinder.setMovements(movements);
    const goal = new goals.GoalFollow(targetPlayer, 3);
    this.bot.pathfinder.setGoal(goal, true);

    return {
      success: true,
      message: `プレイヤー "${playerName}" の追従を開始しました。`,
    };
  }

  /**
   * Minecraftスラッシュコマンドの実行
   */
  public async executeCommand(command: string): Promise<ToolCallResult> {
    try {
      // 改行を除去し、先頭に / がなければ付与
      const sanitized = command.replace(/[\r\n]+/g, ' ').trim();
      if (!sanitized) {
        return { success: false, message: 'コマンドが空です。' };
      }
      const finalCommand = sanitized.startsWith('/') ? sanitized : `/${sanitized}`;
      if (finalCommand.length > 256) {
        return { success: false, message: 'コマンドが長すぎます。' };
      }
      this.bot.chat(finalCommand);
      return { success: true, message: `コマンドを実行しました: ${finalCommand}` };
    } catch (err: any) {
      return { success: false, message: `コマンド実行エラー: ${err.message}` };
    }
  }

  /**
   * 指定座標にコマンドブロックを設置し、コマンドと種類を設定する。
   * bot.setCommandBlock はクリエイティブモードが必要。
   * commandType: 'impulse'(REDSTONE=2) / 'chain'(SEQUENCE=0) / 'repeat'(AUTO=1)
   */
  public async placeCommandBlock(
    x: number, y: number, z: number,
    command: string,
    commandType: 'impulse' | 'chain' | 'repeat' = 'impulse'
  ): Promise<ToolCallResult> {
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const existing = this.bot.blockAt(pos);
    const isCmdBlock = !!existing && existing.name.includes('command_block');
    const failPlace = (message: string): ToolCallResult => {
      this.recordCommandBlock(x, y, z, command, false, message);
      return { success: false, message };
    };
    if (existing && !isCmdBlock && existing.name !== 'air' && existing.name !== 'cave_air' && existing.name !== 'void_air') {
      return failPlace(`座標 (${x},${y},${z}) には既にブロック(${existing.name})があります。`);
    }

    const MODE_MAP: Record<string, number> = { chain: 0, repeat: 1, impulse: 2 };
    const mode = MODE_MAP[commandType] ?? 2;
    const cmd = (command || '').replace(/[\r\n]/g, ' ').trim().slice(0, 32500);
    if (!cmd) return failPlace('コマンドが空です。');

    if (!(await this.ensureCreativeMode())) {
      return failPlace('コマンドブロックの設定にはクリエイティブモードが必要です。サーバーで /gamemode creative を実行する権限があるか確認してください。');
    }

    try {
      if (!isCmdBlock) {
        let slot = this.bot.inventory.items().findIndex(i => i.name === 'command_block');
        if (slot < 0) {
          await this.bot.creative.setInventorySlot(36, { name: 'command_block', count: 1 } as any);
          slot = this.bot.inventory.items().findIndex(i => i.name === 'command_block');
        }
        if (slot < 0) {
          // クリエイティブでも取れない場合は /give を試行
          try {
            this.bot.chat('/give @s minecraft:command_block 1');
            await new Promise(r => setTimeout(r, 1200));
            await this.bot.creative.setInventorySlot(36, { name: 'command_block', count: 1 } as any);
            slot = this.bot.inventory.items().findIndex(i => i.name === 'command_block');
          } catch { /* ignore */ }
        }
        if (slot < 0) return failPlace('コマンドブロックのアイテムが見つかりません。');
        await this.bot.equip(this.bot.inventory.items()[slot], 'hand');

        const candidates: Array<{ ref: any; face: Vec3 }> = [
          { ref: this.bot.blockAt(pos.offset(0, -1, 0)), face: new Vec3(0, 1, 0) },
          { ref: this.bot.blockAt(pos.offset(1, 0, 0)), face: new Vec3(-1, 0, 0) },
          { ref: this.bot.blockAt(pos.offset(-1, 0, 0)), face: new Vec3(1, 0, 0) },
          { ref: this.bot.blockAt(pos.offset(0, 0, 1)), face: new Vec3(0, 0, -1) },
          { ref: this.bot.blockAt(pos.offset(0, 0, -1)), face: new Vec3(0, 0, 1) },
          { ref: this.bot.blockAt(pos.offset(0, 1, 0)), face: new Vec3(0, -1, 0) },
        ];
        let placed = false;
        for (const c of candidates) {
          if (!c.ref || c.ref.name === 'air') continue;
          try {
            await this.bot.placeBlock(c.ref, c.face);
            placed = true;
            break;
          } catch { /* 次の候補へ */ }
        }
        if (!placed) return failPlace('コマンドブロックを設置できませんでした（設置場所がありません）。');
        await new Promise(r => setTimeout(r, 400));
      }

      const placedBlock = this.bot.blockAt(pos);
      if (!placedBlock || !placedBlock.name.includes('command_block')) {
        return failPlace('コマンドブロックの設置を確認できませんでした。');
      }

      await (this.bot as any).setCommandBlock(pos, cmd, {
        mode,
        trackOutput: false,
        conditional: false,
        alwaysActive: false,
      });

      const typeLabel = commandType === 'chain' ? 'チェーン' : commandType === 'repeat' ? 'リピート' : 'インパルス';
      const okMessage = `コマンドブロック(${typeLabel})を (${x},${y},${z}) に設置し、コマンドを設定しました: ${cmd}`;
      this.recordCommandBlock(x, y, z, cmd, true, okMessage);
      return { success: true, message: okMessage };
    } catch (err: any) {
      return failPlace(`コマンドブロック設置エラー: ${err.message}`);
    }
  }

  /**
   * コマンドブロックで設計図を一括建築する（クリエイティブモード必須）。
   * 同一ブロックの連続区間を /fill、単発を /setblock コマンドに変換し、
   * 1つのコマンドブロックに順番に設定→レッドストーンパルスで発動させる。
   */
  public async buildWithCommandBlocks(
    blueprint: any,
    originX: number, originY: number, originZ: number
  ): Promise<ToolCallResult> {
    if (!blueprint || !blueprint.structure) {
      return { success: false, message: '設計図がありません。' };
    }
    if (!(await this.ensureCreativeMode())) {
      return { success: false, message: 'コマンドブロック建築にはクリエイティブモードが必要です。サーバーで /gamemode creative を実行する権限があるか確認してください。' };
    }
    const entries: Array<{ x: number; y: number; z: number; block: string }> = [];
    for (const list of Object.values(blueprint.structure as Record<string, any[]>)) {
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (e && typeof e.block === 'string' && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)) {
          entries.push({ x: Math.floor(originX) + e.x, y: Math.floor(originY) + e.y, z: Math.floor(originZ) + e.z, block: e.block });
        }
      }
    }
    if (entries.length === 0) return { success: false, message: '設計図にブロックがありません。' };

    // 同一 (y,z,block) で x が連続する区間を /fill にまとめる
    const sorted = [...entries].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x || a.block.localeCompare(b.block));
    const commands: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      const cur = sorted[i];
      let j = i;
      while (j + 1 < sorted.length) {
        const n = sorted[j + 1];
        if (n.y === cur.y && n.z === cur.z && n.x === sorted[j].x + 1 && n.block === cur.block) j++;
        else break;
      }
      const runLen = j - i + 1;
      if (runLen >= 3) {
        commands.push(`fill ${cur.x} ${cur.y} ${cur.z} ${sorted[j].x} ${cur.y} ${cur.z} ${cur.block}`);
      } else {
        for (let k = i; k <= j; k++) {
          commands.push(`setblock ${sorted[k].x} ${sorted[k].y} ${sorted[k].z} ${sorted[k].block}`);
        }
      }
      i = j + 1;
    }
    if (commands.length > 500) {
      return { success: false, message: `コマンド数が多すぎます（${commands.length}）。buildBlueprint での手作業建築を使ってください。` };
    }

    try {
      // コマンドブロック設置場所: Botの足元の4ブロック先・足元Y（空気を確保）
      const bp = this.bot.entity.position.floored();
      const cbPos = new Vec3(bp.x + 3, bp.y, bp.z);
      for (let dx = 3; dx <= 8; dx++) {
        const p = new Vec3(bp.x + dx, bp.y, bp.z);
        const b = this.bot.blockAt(p);
        if (b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')) {
          const below = this.bot.blockAt(p.offset(0, -1, 0));
          if (below && below.name !== 'air') { cbPos.x = p.x; cbPos.z = p.z; break; }
        }
      }
      // コマンドブロックを設置
      const existing = this.bot.blockAt(cbPos);
      if (!existing || !existing.name.includes('command_block')) {
        await this.placeCommandBlock(cbPos.x, cbPos.y, cbPos.z, 'time set day', 'impulse');
      }
      const cbBlock = this.bot.blockAt(cbPos);
      if (!cbBlock || !cbBlock.name.includes('command_block')) {
        return { success: false, message: 'コマンドブロックを設置できませんでした。' };
      }

      // レッドストーントーチを隣に置いてパルス発動（設置→掘削でON/OFF）
      const torchItem = this.bot.inventory.items().find(it => it.name === 'redstone_torch')
        || await this.bot.creative.setInventorySlot(36, { name: 'redstone_torch', count: 1 } as any).then(() =>
             this.bot.inventory.items().find(it => it.name === 'redstone_torch'));
      if (!torchItem) return { success: false, message: 'レッドストーントーチを用意できませんでした。' };
      await this.bot.equip(torchItem, 'hand');
      const torchRef = this.bot.blockAt(cbPos.offset(1, 0, 0));
      const torchPos = cbPos.offset(1, 0, 0);

      let executed = 0;
      const total = commands.length;
      for (const cmd of commands) {
        await (this.bot as any).setCommandBlock(cbPos, cmd, { mode: 2, trackOutput: false });
        // パルス: トーチ設置→少し待つ→掘削
        try {
          if (torchRef && torchRef.name !== 'air') {
            await this.bot.placeBlock(torchRef, new Vec3(1, 0, 0));
          } else {
            const belowRef = this.bot.blockAt(cbPos.offset(0, -1, 0));
            if (belowRef) await this.bot.placeBlock(belowRef, new Vec3(0, 1, 0));
          }
        } catch { /* トーチ設置失敗は無視して次へ */ }
        await new Promise(r => setTimeout(r, 250));
        try {
          const tb = this.bot.blockAt(torchPos);
          if (tb && tb.name.includes('redstone_torch')) await this.bot.dig(tb);
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 120));
        executed++;
        if (executed % 20 === 0) {
          try { this.blueprintProgress?.(`コマンドブロック建築中... ${executed}/${total} コマンド実行済み`); } catch { /* ignore */ }
        }
      }
      const name = blueprint.name || '設計図';
      return { success: true, message: `${name} をコマンドブロックで一括建築しました（${total} コマンド実行、${entries.length} ブロック相当）。` };
    } catch (err: any) {
      return { success: false, message: `コマンドブロック建築エラー: ${err.message}` };
    }
  }

  /**
   * コマンドブロックにレッドストーンパルスを送って発動させる（ベストエフォート）。
   */
  public async triggerCommandBlock(x: number, y: number, z: number): Promise<ToolCallResult> {
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = this.bot.blockAt(pos);
    const failTrigger = (message: string): ToolCallResult => {
      this.recordCommandBlock(x, y, z, block && block.name.includes('command_block') ? '(trigger)' : '', false, message);
      return { success: false, message };
    };
    if (!block || !block.name.includes('command_block')) {
      return failTrigger(`座標 (${x},${y},${z}) にコマンドブロックがありません。`);
    }
    try {
      const torchItem = this.bot.inventory.items().find(i => i.name === 'redstone_torch');
      if (!torchItem) {
        return failTrigger('発動用のレッドストーントーチがインベントリにありません。');
      }
      await this.bot.equip(torchItem, 'hand');
      const side = this.bot.blockAt(pos.offset(1, 0, 0));
      if (side && side.name !== 'air') {
        await this.bot.placeBlock(side, new Vec3(1, 0, 0));
        const okMessage = 'コマンドブロックにレッドストーンパルスを送りました。';
        this.recordCommandBlock(x, y, z, '(trigger)', true, okMessage);
        return { success: true, message: okMessage };
      }
      return failTrigger('コマンドブロックの隣に設置可能なブロックがありません。');
    } catch (err: any) {
      return failTrigger(`コマンドブロック発動エラー: ${err.message}`);
    }
  }

  /**
   * 移動や追従の停止
   */
  public async stopActions(): Promise<ToolCallResult> {
    this.stopFollowing();
    try {
      if ((this.bot as any).collectBlock && typeof (this.bot as any).collectBlock.cancelTask === 'function') {
        await (this.bot as any).collectBlock.cancelTask();
      }
    } catch { }
    try {
      this.bot.pathfinder.stop();
    } catch { }
    try {
      if ((this.bot as any).pvp) {
        (this.bot as any).pvp.stop();
      }
    } catch { }
    try {
      this.bot.stopDigging();
    } catch { }
    try {
      this.bot.clearControlStates();
    } catch { }
    return { success: true, message: 'すべての行動・移動を停止しました。' };
  }

  private stopFollowing() {
    this.isFollowing = false;
    this.followTarget = null;
    if (this.followInterval) {
      clearInterval(this.followInterval);
      this.followInterval = null;
    }
  }

  /**
   * 最適なツールを装備
   */
  private async equipToolForBlock(block: any): Promise<void> {
    if (!block) return;
    const inv = this.bot.inventory.items();
    const bName = block.name.toLowerCase();

    let bestTool = null;
    if (bName.includes('log') || bName.includes('wood') || bName.includes('plank')) {
      bestTool = inv.find(i => i.name.includes('axe') && !i.name.includes('pickaxe'));
    } else if (bName.includes('stone') || bName.includes('ore') || bName.includes('cobble') || bName.includes('iron') || bName.includes('gold') || bName.includes('diamond')) {
      // 強いツルハシ優先 (netherite > diamond > iron > stone > wooden)
      bestTool = inv.find(i => i.name === 'netherite_pickaxe')
        || inv.find(i => i.name === 'diamond_pickaxe')
        || inv.find(i => i.name === 'iron_pickaxe')
        || inv.find(i => i.name === 'stone_pickaxe')
        || inv.find(i => i.name === 'wooden_pickaxe')
        || inv.find(i => i.name.includes('pickaxe'));
    } else if (bName.includes('dirt') || bName.includes('sand') || bName.includes('gravel')) {
      bestTool = inv.find(i => i.name.includes('shovel'));
    }

    if (bestTool) {
      try {
        await this.bot.equip(bestTool, 'hand');
      } catch {
        // ignore
      }
    }
  }

  /**
   * 採掘に必要なツールのチェック（前提ツールの確認）
   */
  private checkToolRequirement(blockName: string): { ok: boolean; reason?: string } {
    const inv = this.bot.inventory.items();
    const b = blockName.toLowerCase();

    const hasPickaxe = (types: string[]) => inv.some(i => types.some(t => i.name.includes(t)));

    // ダイヤ/金/赤石鉱石 -> 鉄ツルハシ以上必要
    if (b.includes('diamond') || b.includes('gold') || b.includes('redstone') || b.includes('emerald')) {
      if (!hasPickaxe(['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])) {
        return {
          ok: false,
          reason: `"${blockName}" の採掘には「鉄のツルハシ (iron_pickaxe)」以上が必要です。現在の持ち物に鉄のツルハシがありません。まずは石のツルハシで鉄鉱石を採掘・製錬して鉄のツルハシを作成してください。`,
        };
      }
    }

    // 鉄鉱石/ラピス -> 石ツルハシ以上必要
    if (b.includes('iron_ore') || b.includes('iron') || b.includes('lapis')) {
      if (!hasPickaxe(['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])) {
        return {
          ok: false,
          reason: `"${blockName}" の採掘には「石のツルハシ (stone_pickaxe)」以上が必要です。素手や木のツルハシではアイテムがドロップしません。まずは木を掘って木のツルハシを作り、丸石を3個掘って石のツルハシをクラフトしてください。`,
        };
      }
    }

    // 石/丸石/石炭鉱石 -> 木ツルハシ以上必要
    if (b.includes('stone') || b.includes('cobble') || b.includes('coal_ore') || b.includes('deepslate')) {
      if (!hasPickaxe(['pickaxe'])) {
        return {
          ok: false,
          reason: `"${blockName}" の採掘には「ツルハシ (pickaxe)」が必要です。素手ではドロップしません。まずは木（原木）を掘って木材と作業台を作り、木のツルハシ(wooden_pickaxe)をクラフトしてください。`,
        };
      }
    }

    return { ok: true };
  }

  /**
   * 指定ブロックの探索・採掘・ドロップアイテム回収
   */
  public async mineAndCollect(blockName: string, count: number = 1): Promise<ToolCallResult> {
    this.stopFollowing();
    const mcData = this.getMCData();
    if (!mcData) return { success: false, message: 'Minecraftデータが初期化されていません。' };

    // 1. ツールの前提条件チェック
    const toolCheck = this.checkToolRequirement(blockName);
    if (!toolCheck.ok) {
      return { success: false, message: toolCheck.reason! };
    }

    // 2. ブロックIDのマッピング
    let targetBlockIds: number[] = [];
    const lowerName = blockName.toLowerCase().replace(/ /g, '_');

    if (lowerName === 'wood' || lowerName === 'log' || lowerName === '木' || lowerName === '原木') {
      const logs = Object.values(mcData.blocksByName)
        .filter((b: any) => b.name.endsWith('_log') || b.name.endsWith('_stem') || b.name === 'log')
        .map((b: any) => b.id);
      targetBlockIds = logs;
    } else if (lowerName === 'iron_ore' || lowerName === 'iron' || lowerName === '鉄鉱石') {
      const ores = Object.values(mcData.blocksByName)
        .filter((b: any) => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore')
        .map((b: any) => b.id);
      targetBlockIds = ores;
    } else if (lowerName === 'coal_ore' || lowerName === 'coal' || lowerName === '石炭') {
      const ores = Object.values(mcData.blocksByName)
        .filter((b: any) => b.name === 'coal_ore' || b.name === 'deepslate_coal_ore')
        .map((b: any) => b.id);
      targetBlockIds = ores;
    } else if (lowerName === 'diamond_ore' || lowerName === 'diamond' || lowerName === 'ダイヤ') {
      const ores = Object.values(mcData.blocksByName)
        .filter((b: any) => b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore')
        .map((b: any) => b.id);
      targetBlockIds = ores;
    } else if (lowerName === 'stone' || lowerName === '石' || lowerName === '丸石') {
      const stones = Object.values(mcData.blocksByName)
        .filter((b: any) => b.name === 'stone' || b.name === 'cobblestone' || b.name === 'andesite' || b.name === 'diorite' || b.name === 'granite')
        .map((b: any) => b.id);
      targetBlockIds = stones;
    } else {
      const block = mcData.blocksByName[lowerName];
      if (block) {
        targetBlockIds = [block.id];
      } else {
        const matches = Object.values(mcData.blocksByName)
          .filter((b: any) => b.name.includes(lowerName))
          .map((b: any) => b.id);
        if (matches.length > 0) {
          targetBlockIds = matches;
        } else {
          return { success: false, message: `ブロック "${blockName}" がMinecraft内に見つかりません。` };
        }
      }
    }

    let collected = 0;
    const maxScanRadius = 32;

    for (let i = 0; i < count; i++) {
      // 周囲から見つかるブロックを探索
      const block = this.bot.findBlock({
        matching: targetBlockIds,
        maxDistance: maxScanRadius,
      });

      if (!block) {
        if (collected > 0) {
          return {
            success: true,
            message: `半径${maxScanRadius}m以内にこれ以上 "${blockName}" が見つかりませんでした。${collected}個採掘しました。`,
          };
        }
        return {
          success: false,
          message: `半径${maxScanRadius}m以内に "${blockName}" が見つかりませんでした。視界が開けた場所や洞窟を探すか、別の行動をとってください。`,
        };
      }

      await this.equipToolForBlock(block);

      try {
        // タイムアウト付きで採掘＆回収を実行 (1個あたり15秒上限)
        await withTimeout((async () => {
          if ((this.bot as any).collectBlock) {
            await (this.bot as any).collectBlock.collect(block);
          } else {
            const movements = this.getMovements();
            this.bot.pathfinder.setMovements(movements);
            await this.bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, this.bot.world));
            await this.bot.dig(block);
            // 落ちたアイテムの回収
            await this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1));
          }
        })(), 15000, `"${blockName}" の採掘・回収がタイムアウトしました。`);

        collected++;
      } catch (err: any) {
        console.warn(`[Mine] Error collecting block at step ${i + 1}:`, err.message);
        this.bot.pathfinder.stop();
        if (collected > 0) {
          return {
            success: true,
            message: `${collected}個採掘後に中断しました: ${err.message}`,
          };
        }
        return {
          success: false,
          message: `"${blockName}" の採掘中にエラーまたはタイムアウトが発生しました: ${err.message}`,
        };
      }
    }

    return {
      success: true,
      message: `ブロック "${blockName}" を ${collected} 個採掘・回収しました。`,
    };
  }

  /**
   * アイテムのクラフト
   */
  public async craftItem(itemName: string, count: number = 1): Promise<ToolCallResult> {
    const mcData = this.getMCData();
    if (!mcData) return { success: false, message: 'Minecraftデータが初期化されていません。' };

    let lowerName = itemName.toLowerCase().replace(/ /g, '_');

    // 一般的な日本語名やエイリアスのマッピング
    if (lowerName === '作業台' || lowerName === 'crafting_table') lowerName = 'crafting_table';
    if (lowerName === '棒' || lowerName === 'stick') lowerName = 'stick';
    if (lowerName === '木材' || lowerName === 'planks') lowerName = 'oak_planks';
    if (lowerName === '木のツルハシ' || lowerName === 'wood_pickaxe') lowerName = 'wooden_pickaxe';
    if (lowerName === '石のツルハシ' || lowerName === 'stone_pickaxe') lowerName = 'stone_pickaxe';
    if (lowerName === '鉄のツルハシ' || lowerName === 'iron_pickaxe') lowerName = 'iron_pickaxe';
    if (lowerName === 'かまど' || lowerName === 'furnace') lowerName = 'furnace';

    const item = mcData.itemsByName[lowerName] || mcData.blocksByName[lowerName];
    if (!item) {
      return { success: false, message: `アイテム "${itemName}" が見つかりません。` };
    }

    // 周囲の作業台を探索 (3x3レシピ用)
    let craftingTableBlock = this.bot.findBlock({
      matching: mcData.blocksByName.crafting_table?.id,
      maxDistance: 4,
    });

    let recipes = (this.bot as any).recipesFor(item.id, null, 1, craftingTableBlock);

    // 作業台が近くにないが、インベントリに作業台を持っている場合は設置を試みる
    if ((!recipes || recipes.length === 0) && !craftingTableBlock) {
      const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
      if (tableItem) {
        console.log('[Craft] Placing crafting table from inventory...');
        await this.placeBlock('crafting_table');
        craftingTableBlock = this.bot.findBlock({
          matching: mcData.blocksByName.crafting_table?.id,
          maxDistance: 4,
        });
        recipes = (this.bot as any).recipesFor(item.id, null, 1, craftingTableBlock);
      }
    }

    if (!recipes || recipes.length === 0) {
      const tableRecipes = (this.bot as any).recipesFor(item.id, null, 1, true);
      if (tableRecipes && tableRecipes.length > 0) {
        return {
          success: false,
          message: `"${itemName}" のクラフトには「作業台 (crafting_table)」が必要です。まずは木材4個で作業台を作り、設置してください。`,
        };
      }
      return {
        success: false,
        message: `"${itemName}" のクラフト素材が不足しています。必要な素材を確認して採掘・収集してください。`,
      };
    }

    try {
      const recipe = recipes[0];
      await withTimeout(
        this.bot.craft(recipe, count, craftingTableBlock || undefined),
        10000,
        `"${itemName}" のクラフト処理がタイムアウトしました。`
      );
      return {
        success: true,
        message: `"${itemName}" を ${count} 個クラフトしました。`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `"${itemName}" のクラフトに失敗しました: ${err.message}`,
      };
    }
  }

  /**
   * ブロックを設置
   */
  public async placeBlock(blockName: string, x?: number, y?: number, z?: number): Promise<ToolCallResult> {
    const mcData = this.getMCData();
    if (!mcData) return { success: false, message: 'Minecraftデータが初期化されていません。' };

    const lowerName = blockName.toLowerCase().replace(/ /g, '_');
    const blockItem = mcData.itemsByName[lowerName] || mcData.blocksByName[lowerName];
    if (!blockItem) {
      return { success: false, message: `アイテム "${blockName}" が見つかりません。` };
    }

    const itemInInv = this.bot.inventory.items().find(i => i.type === blockItem.id);
    if (!itemInInv) {
      return { success: false, message: `インベントリに "${blockName}" を持っていません。` };
    }

    try {
      await this.bot.equip(itemInInv, 'hand');

      let targetPos: Vec3;
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number' &&
          Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        targetPos = new Vec3(x, y, z);
      } else {
        // 目の前の地面 (足元の1つ前)
        targetPos = this.bot.entity.position.offset(0, -1, 1).floored();
      }

      const referenceBlock = this.bot.blockAt(targetPos);
      if (!referenceBlock) {
        return { success: false, message: '設置先の基準ブロックが見つかりません。' };
      }

      await withTimeout(
        this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0)),
        5000,
        `"${blockName}" の設置がタイムアウトしました。`
      );
      return {
        success: true,
        message: `"${blockName}" を設置しました。`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `"${blockName}" の設置に失敗しました: ${err.message}`,
      };
    }
  }

  /**
   * 周囲の食料動物または一般的な敵対Mobを狩り、落としたアイテムを回収
   */
  public async huntMob(maxTargets: number = 3, targetType: 'animals' | 'hostiles' | 'any' = 'any'): Promise<ToolCallResult> {
    this.stopFollowing();
    if (!this.bot.entity) return { success: false, message: 'Botがワールド内にいないため狩りを開始できません。' };

    const limit = Math.max(1, Math.min(5, Math.floor(Number(maxTargets) || 3)));
    const allowedType = targetType === 'animals' || targetType === 'hostiles' ? targetType : 'any';
    const attempted = new Set<number>();
    const killed: string[] = [];
    const before = new Map<string, number>();
    for (const item of this.bot.inventory.items()) before.set(item.name, (before.get(item.name) || 0) + item.count);

    const pvp = (this.bot as any).pvp;
    if (!pvp || typeof pvp.attack !== 'function') {
      return { success: false, message: '戦闘スキルが利用できません。' };
    }

    for (let count = 0; count < limit; count += 1) {
      if ((this.bot.health ?? 20) <= 5) break;
      const candidates = Object.values(this.bot.entities).filter((entity: any) => {
        if (!entity || entity === this.bot.entity || entity.type !== 'mob' || !entity.position || attempted.has(entity.id)) return false;
        const name = String(entity.name || '').toLowerCase();
        const isAnimal = HUNTABLE_ANIMALS.has(name);
        const isHostile = HUNTABLE_HOSTILES.has(name);
        if (allowedType === 'animals' && !isAnimal) return false;
        if (allowedType === 'hostiles' && !isHostile) return false;
        if (allowedType === 'any' && !isAnimal && !isHostile) return false;
        return this.bot.entity.position.distanceTo(entity.position) <= 24;
      }) as any[];
      candidates.sort((left, right) => this.bot.entity.position.distanceTo(left.position) - this.bot.entity.position.distanceTo(right.position));
      const target = candidates[0];
      if (!target) break;
      attempted.add(target.id);

      try {
        const weaponOrder = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
        const inventory = this.bot.inventory.items();
        const weapon = weaponOrder.map(name => inventory.find(item => item.name === name)).find(Boolean);
        if (weapon) await this.bot.equip(weapon, 'hand');
        this.bot.pathfinder.setMovements(this.getMovements());

        const wasKilled = await new Promise<boolean>(resolve => {
          let settled = false;
          const finish = (result: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(checkTarget);
            this.bot.removeListener('entityDead', onEntityDead);
            resolve(result);
          };
          const onEntityDead = (entity: any) => {
            if (entity?.id === target.id) finish(true);
          };
          const timeout = setTimeout(() => finish(false), 20000);
          const checkTarget = setInterval(() => {
            if (!this.bot.entity || (this.bot.health ?? 20) <= 4) return finish(false);
            const currentTarget = this.bot.entities[target.id];
            if (!currentTarget || currentTarget.health === 0) finish(currentTarget?.health === 0);
            else if (this.bot.entity.position.distanceTo(currentTarget.position) > 32) finish(false);
          }, 300);
          this.bot.on('entityDead', onEntityDead);
          try { Promise.resolve(pvp.attack(target)).catch(() => finish(false)); }
          catch { finish(false); }
        });

        try { await pvp.stop(); } catch { }
        this.bot.pathfinder.stop();
        if (!wasKilled) break;
        killed.push(String(target.name || 'mob'));
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.collectNearbyHuntDrops();
      } catch (error) {
        try { await pvp.stop(); } catch { }
        this.bot.pathfinder.stop();
        const message = error instanceof Error ? error.message : String(error);
        const collected = this.describeInventoryGain(before);
        return { success: killed.length > 0, message: `狩りを中断しました (${message})。討伐: ${killed.join(', ') || 'なし'}。${collected}` };
      }
    }

    const collected = this.describeInventoryGain(before);
    if (killed.length === 0) {
      const reason = (this.bot.health ?? 20) <= 5 ? '体力が少ないため安全のため中断しました。' : '近くに狩猟対象がいないか、制限時間内に倒せませんでした。';
      return { success: false, message: `${reason} ${collected}` };
    }
    return { success: true, message: `狩りを完了しました。討伐: ${killed.join(', ')}。${collected}` };
  }

  private async collectNearbyHuntDrops(): Promise<void> {
    for (let pass = 0; pass < 6 && this.bot.entity; pass += 1) {
      const drops = Object.values(this.bot.entities).filter((entity: any) =>
        entity && entity.name === 'item' && entity.position && this.bot.entity.position.distanceTo(entity.position) <= 12
      ) as any[];
      drops.sort((left, right) => this.bot.entity!.position.distanceTo(left.position) - this.bot.entity!.position.distanceTo(right.position));
      const drop = drops[0];
      if (!drop) return;
      try {
        this.bot.pathfinder.setMovements(this.getMovements());
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)), 8000, 'ドロップ回収への移動がタイムアウトしました。');
        await new Promise(resolve => setTimeout(resolve, 900));
      } catch {
        this.bot.pathfinder.stop();
        return;
      }
    }
  }

  private describeInventoryGain(before: Map<string, number>): string {
    const gained: string[] = [];
    const current = new Map<string, number>();
    for (const item of this.bot.inventory.items()) current.set(item.name, (current.get(item.name) || 0) + item.count);
    for (const [name, count] of current) {
      const difference = count - (before.get(name) || 0);
      if (difference > 0) gained.push(`${name} x${difference}`);
    }
    return gained.length ? `回収: ${gained.join(', ')}` : '回収できたドロップはありません。';
  }

  /**
   * 指定モブまたはターゲットを攻撃
   */
  public async attackTarget(targetName: string): Promise<ToolCallResult> {
    this.stopFollowing();
    const lowerName = targetName.toLowerCase();

    let targetEntity = null;
    for (const id in this.bot.entities) {
      const entity = this.bot.entities[id];
      if (!entity || entity === this.bot.entity) continue;

      const eName = (entity.name || entity.username || '').toLowerCase();
      if (eName.includes(lowerName) || (lowerName === 'mob' && entity.type === 'mob')) {
        targetEntity = entity;
        break;
      }
    }

    if (!targetEntity) {
      return {
        success: false,
        message: `周囲にターゲット "${targetName}" が見つかりません。`,
      };
    }

    try {
      const weapon = this.bot.inventory.items().find(i =>
        i.name.includes('sword') || i.name.includes('axe')
      );
      if (weapon) {
        await this.bot.equip(weapon, 'hand');
      }
    } catch {
      // ignore
    }

    try {
      if ((this.bot as any).pvp) {
        (this.bot as any).pvp.attack(targetEntity);
        return {
          success: true,
          message: `ターゲット "${targetName}" への攻撃を開始しました。`,
        };
      } else {
        await this.bot.attack(targetEntity);
        return {
          success: true,
          message: `ターゲット "${targetName}" を攻撃しました。`,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        message: `攻撃中にエラーが発生しました: ${err.message}`,
      };
    }
  }

  /**
   * プレイヤーにアイテムを渡す
   */
  public async giveItemsToPlayer(playerName: string, itemName: string, count: number = 1): Promise<ToolCallResult> {
    const targetPlayer = this.bot.players[playerName]?.entity;
    if (!targetPlayer) {
      return { success: false, message: `プレイヤー "${playerName}" が見つかりません。` };
    }

    const moveRes = await this.goToPlayer(playerName);
    if (!moveRes.success) return moveRes;

    const mcData = this.getMCData();
    const lowerName = itemName.toLowerCase().replace(/ /g, '_');
    const itemInfo = mcData?.itemsByName[lowerName] || mcData?.blocksByName[lowerName];

    const invItem = this.bot.inventory.items().find(i =>
      i.name.toLowerCase() === lowerName || (itemInfo && i.type === itemInfo.id)
    );

    if (!invItem) {
      return { success: false, message: `インベントリに "${itemName}" がありません。` };
    }

    try {
      await this.bot.lookAt(targetPlayer.position.offset(0, 1.5, 0));
      const dropCount = Math.min(count, invItem.count);
      await this.bot.toss(invItem.type, null, dropCount);
      return {
        success: true,
        message: `プレイヤー "${playerName}" に "${itemName}" を ${dropCount} 個渡しました。`,
      };
    } catch (err: any) {
      return { success: false, message: `アイテムを渡すのに失敗しました: ${err.message}` };
    }
  }

  /**
   * アイテムを捨てる
   */
  public async dropItem(itemName: string, count: number = 1): Promise<ToolCallResult> {
    const lowerName = itemName.toLowerCase().replace(/ /g, '_');
    const invItem = this.bot.inventory.items().find(i =>
      i.name.toLowerCase().includes(lowerName)
    );

    if (!invItem) {
      return { success: false, message: `インベントリに "${itemName}" がありません。` };
    }

    try {
      const dropCount = Math.min(count, invItem.count);
      await this.bot.toss(invItem.type, null, dropCount);
      return {
        success: true,
        message: `"${itemName}" を ${dropCount} 個その場に捨てました。`,
      };
    } catch (err: any) {
      return { success: false, message: `アイテムを捨てるのに失敗しました: ${err.message}` };
    }
  }

  /**
   * 装備品を着用
   */
  public async equipItem(itemName: string, destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' = 'hand'): Promise<ToolCallResult> {
    const lowerName = itemName.toLowerCase().replace(/ /g, '_');
    const item = this.bot.inventory.items().find(i => i.name.toLowerCase().includes(lowerName));

    if (!item) {
      return { success: false, message: `インベントリに "${itemName}" がありません。` };
    }

    try {
      await this.bot.equip(item, destination);
      return {
        success: true,
        message: `"${itemName}" を ${destination} に装備しました。`,
      };
    } catch (err: any) {
      return { success: false, message: `装備に失敗しました: ${err.message}` };
    }
  }

  /**
   * 食事を摂る
   */
  public async eat(): Promise<ToolCallResult> {
    try {
      if ((this.bot as any).autoEat) {
        await (this.bot as any).autoEat.eat();
        return { success: true, message: '食事をして満腹度を回復しました。' };
      }
      return { success: false, message: 'auto-eat プラグインが無効です。' };
    } catch (err: any) {
      return { success: false, message: `食事に失敗しました: ${err.message}` };
    }
  }
}




