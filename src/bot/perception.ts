import { Bot } from 'mineflayer';
import { BotStatus } from '../types.js';
import { Vec3 } from 'vec3';

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'drowned', 'husk', 'stray', 'phantom', 'pillager',
  'vindicator', 'evoker', 'ravager', 'hoglin', 'piglin_brute', 'warden'
]);

export class PerceptionManager {
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * 現在のBotの詳細ステータスを取得
   */
  public getStatus(currentTask: string | null = null, isExecuting: boolean = false): BotStatus {
    const pos = this.bot.entity ? this.bot.entity.position : new Vec3(0, 0, 0);

    // インベントリのアイテム一覧
    const rawItems = this.bot.inventory?.items() || [];
    const itemMap = new Map<string, { name: string; count: number; displayName: string }>();
    for (const item of rawItems) {
      if (itemMap.has(item.name)) {
        itemMap.get(item.name)!.count += item.count;
      } else {
        itemMap.set(item.name, {
          name: item.name,
          count: item.count,
          displayName: item.displayName || item.name,
        });
      }
    }
    const inventory = Array.from(itemMap.values());

    // 装備中の防具
    const equippedArmor = {
      helmet: this.bot.inventory?.slots[5]?.name,
      chestplate: this.bot.inventory?.slots[6]?.name,
      leggings: this.bot.inventory?.slots[7]?.name,
      boots: this.bot.inventory?.slots[8]?.name,
    };

    // 手持ちアイテム
    const heldItem = this.bot.heldItem ? this.bot.heldItem.name : null;

    // 周囲のエンティティ
    const nearbyEntities: BotStatus['nearbyEntities'] = [];
    if (this.bot.entities) {
      for (const id in this.bot.entities) {
        const entity = this.bot.entities[id];
        if (!entity || entity === this.bot.entity || !entity.position) continue;

        const distance = Math.round(pos.distanceTo(entity.position) * 10) / 10;
        if (distance > 32) continue; // 32ブロック以内のエンティティのみ

        const rawName = entity.name || entity.username || 'unknown';
        const isDroppedItem = /^(item|item_stack)$/i.test(rawName);
        let droppedItem = null;
        if (isDroppedItem) {
          try { droppedItem = entity.getDroppedItem(); } catch { }
        }
        let customName: string | undefined;
        try {
          const formattedName = entity.getCustomName();
          if (formattedName) customName = formattedName.toString().trim();
        } catch { }
        const isPlayer = entity.type === 'player';
        const isHostile = HOSTILE_MOBS.has(rawName.toLowerCase());
        const name = isDroppedItem ? (droppedItem?.name || rawName) : isPlayer ? (entity.username || rawName) : rawName;
        const displayName = isDroppedItem
          ? (droppedItem?.displayName || name)
          : (entity.displayName || (isPlayer ? entity.username : undefined) || name);
        const category: BotStatus['nearbyEntities'][number]['category'] = isDroppedItem
          ? 'item'
          : isPlayer ? 'player'
            : isHostile ? 'hostile'
              : entity.kind === 'animal' || entity.kind === 'ambient' ? 'animal' : 'other';

        nearbyEntities.push({
          name,
          type: isDroppedItem ? 'item' : entity.type || 'other',
          displayName,
          customName,
          category,
          itemCount: droppedItem?.count,
          distance,
          position: {
            x: Math.round(entity.position.x * 10) / 10,
            y: Math.round(entity.position.y * 10) / 10,
            z: Math.round(entity.position.z * 10) / 10,
          },
          isHostile,
          isPlayer,
        });
      }
    }
    nearbyEntities.sort((a, b) => a.distance - b.distance);

    // 周囲の主要ブロック集計（半径8mに縮小してメモリ節約）
    const nearbyBlocksSummary = this.scanNearbyBlocksSummary(8);

    // 時間帯判定
    const timeOfDay = this.bot.time?.timeOfDay ?? 0;
    let timeStr = '昼間';
    if (timeOfDay >= 13000 && timeOfDay < 23000) {
      timeStr = '夜間 (モンスターが出現)';
    } else if (timeOfDay >= 12000 && timeOfDay < 13000) {
      timeStr = '夕方';
    } else if (timeOfDay >= 23000) {
      timeStr = '早朝';
    }

    return {
      health: Math.round(this.bot.health || 20),
      food: Math.round(this.bot.food || 20),
      position: {
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
        z: Math.round(pos.z * 10) / 10,
      },
      dimension: this.bot.game?.dimension || 'overworld',
      gameTime: `${timeStr} (timeOfDay: ${timeOfDay})`,
      biome: this.getBiomeName(),
      inventory,
      heldItem,
      equippedArmor,
      nearbyEntities: nearbyEntities.slice(0, 15), // 上位15体
      nearbyBlocksSummary,
      currentTask,
      isExecuting,
    };
  }

  /**
   * LLM用のプロンプトに埋め込む環境サマリーテキストを生成
   */
  public generateEnvironmentPrompt(currentTask: string | null = null): string {
    const status = this.getStatus(currentTask);

    const invSummary = status.inventory.length > 0
      ? status.inventory.map(i => `${i.name} x${i.count}`).join(', ')
      : 'なし (空っぽ)';

    const armorSummary = Object.entries(status.equippedArmor)
      .filter(([_, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || 'なし';

    const mobs = status.nearbyEntities
      .map(e => `- ${e.name} (種類:${e.type}, 距離:${e.distance}m, 敵対:${e.isHostile ? 'はい' : 'いいえ'})`)
      .join('\n') || 'なし';

    const importantBlocks = Object.entries(status.nearbyBlocksSummary)
      .filter(([name]) => !['air', 'dirt', 'grass_block', 'stone', 'water'].includes(name))
      .slice(0, 20)
      .map(([name, count]) => `${name}: 約${count}個`)
      .join(', ') || '特記事項なし';

    return `
【あなたの現在のステータス】
- 体力: ${status.health}/20, 満腹度: ${status.food}/20
- 現在座標: X=${status.position.x}, Y=${status.position.y}, Z=${status.position.z} (${status.dimension})
- バイオーム: ${status.biome}
- 時間帯: ${status.gameTime}
- 利き手装備: ${status.heldItem || '素手'}
- 防具: ${armorSummary}

【インベントリ (所持アイテム)】
${invSummary}

【周囲のエンティティ (近隣のプレイヤー/Mob)】
${mobs}

【周囲16m以内にある主なブロック】
${importantBlocks}
`.trim();
  }

  /**
   * 周囲のブロックの簡易スキャン
   */
  private scanNearbyBlocksSummary(radius: number): Record<string, number> {
    const summary: Record<string, number> = {};
    if (!this.bot.entity || !this.bot.blockAt) return summary;

    const pos = this.bot.entity.position.floored();
    const step = 2; // パフォーマンスのため2ブロック間隔でサンプリング

    for (let x = -radius; x <= radius; x += step) {
      for (let y = Math.max(-8, -radius); y <= Math.min(8, radius); y += step) {
        for (let z = -radius; z <= radius; z += step) {
          const blockPos = pos.offset(x, y, z);
          const block = this.bot.blockAt(blockPos);
          if (block && block.name !== 'air' && block.name !== 'cave_air') {
            summary[block.name] = (summary[block.name] || 0) + 1;
          }
        }
      }
    }
    return summary;
  }

  private getBiomeName(): string {
    try {
      if (!this.bot.entity || !this.bot.world) return 'unknown';
      const block = this.bot.blockAt(this.bot.entity.position);
      if (block && (block as any).biome) {
        return (block as any).biome.name || 'unknown';
      }
    } catch {
      // ignore
    }
    return 'unknown';
  }
}
