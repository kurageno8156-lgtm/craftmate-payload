import { Bot } from 'mineflayer';
import { EventEmitter } from 'events';

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'drowned', 'husk', 'stray', 'phantom', 'pillager',
  'vindicator', 'evoker', 'ravager', 'hoglin', 'piglin_brute', 'warden',
  'magma_cube', 'silverfish', 'blaze', 'ghast'
]);

/** 戦闘が解除されない場合の安全タイムアウト（ミリ秒） */
const COMBAT_TIMEOUT_MS = 15_000;

export class AutoGuard extends EventEmitter {
  private bot: Bot;
  private isDefending: boolean = false;
  private currentTarget: any = null;
  private scanInterval: NodeJS.Timeout | null = null;
  private combatTimeoutHandle: NodeJS.Timeout | null = null;

  constructor(bot: Bot) {
    super();
    this.bot = bot;
  }

  public start(): void {
    if (this.scanInterval) return;

    // 400msごとに周囲の敵を自動スキャン
    this.scanInterval = setInterval(() => {
      this.checkSurroundings();
    }, 400);

    // 攻撃を受けた瞬間に即座に反撃
    this.bot.on('entityHurt', (entity: any) => {
      if (entity === this.bot.entity) {
        this.onBotDamaged();
      }
    });

    // 敵が死亡・消滅したイベントを検知して戦闘終了
    this.bot.on('entityDead', (entity: any) => {
      if (this.isDefending && this.currentTarget && entity === this.currentTarget) {
        console.log('[AutoGuard] ✅ Target entity dead. Ending combat.');
        this.stopDefending();
      }
    });

    // スポーンイベント時（死亡後リスポーン）にも戦闘状態をリセット
    this.bot.on('spawn', () => {
      if (this.isDefending) {
        console.log('[AutoGuard] Bot respawned. Resetting combat state.');
        this.stopDefending();
      }
    });
  }

  public stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.stopDefending();
  }

  /**
   * 最適な武器を自動装備
   */
  private async equipBestWeapon(): Promise<void> {
    const inv = this.bot.inventory?.items() || [];
    const weaponOrder = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'
    ];

    for (const wName of weaponOrder) {
      const item = inv.find(i => i.name === wName);
      if (item) {
        try {
          await this.bot.equip(item, 'hand');
          return;
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * ダメージを受けた際の即時ターゲット判定
   */
  private onBotDamaged(): void {
    if (this.isDefending) return;

    // 周囲8m以内の最も近い敵を探す
    const nearestHostile = this.findNearestHostile(8);
    if (nearestHostile) {
      console.log(`[AutoGuard] ⚠️ Bot was damaged! Counter-attacking: ${nearestHostile.name || 'hostile mob'}`);
      this.attackEnemy(nearestHostile);
    }
  }

  /**
   * 周囲の敵をスキャンして危険なら迎撃
   */
  private checkSurroundings(): void {
    if (!this.bot.entity || !this.bot.entities) return;

    // 現在戦闘中ならターゲットの生存確認
    if (this.isDefending && this.currentTarget) {
      const targetId = this.currentTarget.id;
      const targetEntity = this.bot.entities[targetId];

      // ターゲットがワールドから消えた or 12m以上離れた場合は戦闘終了
      const isGone = !targetEntity ||
        targetEntity.metadata?.[2] /* isDead heuristic */ ||
        (this.bot.entity.position.distanceTo(targetEntity.position) > 14);

      if (isGone) {
        console.log('[AutoGuard] ✅ Enemy defeated or escaped. Resuming previous task.');
        this.stopDefending();
      }
      return;
    }

    // 5m以内に敵対Mobが接近しているか確認
    const threat = this.findNearestHostile(5);
    if (threat) {
      const dist = Math.round(this.bot.entity.position.distanceTo(threat.position));
      console.log(`[AutoGuard] 🛡️ Hostile mob detected: ${threat.name} (${dist}m). Defending!`);
      this.attackEnemy(threat);
    }
  }

  private findNearestHostile(maxDist: number): any {
    if (!this.bot.entity || !this.bot.entities) return null;

    const pos = this.bot.entity.position;
    let closest: any = null;
    let minDist = maxDist;

    for (const id in this.bot.entities) {
      const entity = this.bot.entities[id];
      if (!entity || entity === this.bot.entity || !entity.position) continue;

      const name = (entity.name || '').toLowerCase();
      if (HOSTILE_MOBS.has(name)) {
        const dist = pos.distanceTo(entity.position);
        if (dist < minDist) {
          minDist = dist;
          closest = entity;
        }
      }
    }
    return closest;
  }

  /**
   * 敵の迎撃開始
   */
  private async attackEnemy(enemy: any): Promise<void> {
    this.isDefending = true;
    this.currentTarget = enemy;

    // 安全タイムアウト：15秒経っても戦闘中なら強制解除してタスクへ戻る
    if (this.combatTimeoutHandle) clearTimeout(this.combatTimeoutHandle);
    this.combatTimeoutHandle = setTimeout(() => {
      if (this.isDefending) {
        console.warn('[AutoGuard] ⏱️ Combat timeout! Force-stopping combat to resume task.');
        this.stopDefending();
      }
    }, COMBAT_TIMEOUT_MS);

    await this.equipBestWeapon();

    try {
      if ((this.bot as any).pvp) {
        (this.bot as any).pvp.attack(enemy);
      } else {
        await this.bot.attack(enemy);
      }
    } catch (err: any) {
      console.warn('[AutoGuard] Attack error:', err.message);
      // 攻撃に失敗した場合は戦闘を即時解除してタスクへ戻す
      this.stopDefending();
    }
  }

  public stopDefending(): void {
    this.isDefending = false;
    this.currentTarget = null;
    if (this.combatTimeoutHandle) {
      clearTimeout(this.combatTimeoutHandle);
      this.combatTimeoutHandle = null;
    }
    if ((this.bot as any).pvp) {
      try { (this.bot as any).pvp.stop(); } catch { /* ignore */ }
    }
  }

  public isInCombat(): boolean {
    return this.isDefending;
  }
}
