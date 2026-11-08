import { MinecraftBot } from '../bot/mcBot.js';
import { LLMClient, LLMResponse } from './llmClient.js';
import { executeBotTool } from './tools.js';
import { AgentStepLog, ChatMessage } from '../types.js';
import { EventEmitter } from 'events';

export class AutonomousAgent extends EventEmitter {
  private botWrapper: MinecraftBot;
  private llmClient: LLMClient;
  private isProcessing: boolean = false;
  private currentTask: string | null = null;
  private abortController: AbortController | null = null;
  private currentExecutionPromise: Promise<void> | null = null;
  private instructionQueue: Promise<void> = Promise.resolve();

  constructor(botWrapper: MinecraftBot) {
    super();
    this.botWrapper = botWrapper;
    this.llmClient = new LLMClient(botWrapper.config);

    // チャット受信時に自動でタスクとして処理
    this.botWrapper.on('playerMessage', (chat: ChatMessage) => {
      this.handleInstruction(chat.text, chat.sender);
    });
  }

  /**
   * 指示の受付と自律実行ループの開始
   */
  public async handleInstruction(instruction: string, requester: string = 'Player'): Promise<void> {
    const runNext = async () => {
      if (this.isProcessing) {
        console.log(`[Agent] Interrupting previous task for new instruction: "${instruction}"`);
        await this.cancelTask();
      }

      this.isProcessing = true;
      this.currentTask = instruction;
      const abortCtrl = new AbortController();
      this.abortController = abortCtrl;

      this.emit('taskStarted', { task: instruction, requester });
      console.log(`\n========================================`);
      console.log(`[Agent] New Goal from ${requester}: "${instruction}"`);
      console.log(`========================================\n`);

      const executionPromise = (async () => {
        try {
          await this.runReActLoop(instruction, requester, abortCtrl.signal);
        } catch (err: any) {
          if (abortCtrl.signal.aborted) {
            console.log(`[Agent] Task "${instruction}" was interrupted.`);
            return;
          }
          console.error('[Agent] Task failed with error:', err.message);
          const failLog: AgentStepLog = {
            timestamp: new Date().toLocaleTimeString(),
            stepNumber: 0,
            observation: `エラーが発生しました: ${err.message}`,
            status: 'failure',
          };
          this.emit('stepLog', failLog);
          await this.botWrapper.skills.chat(`申し訳ありません、タスク中にエラーが発生しました: ${err.message}`);
        } finally {
          if (this.abortController === abortCtrl) {
            this.isProcessing = false;
            this.currentTask = null;
            this.currentExecutionPromise = null;
            this.emit('taskFinished', { task: instruction });
          }
        }
      })();

      this.currentExecutionPromise = executionPromise;
      await executionPromise;
    };

    this.instructionQueue = this.instructionQueue.then(runNext, runNext);
    await this.instructionQueue;
  }

  private async runReActLoop(goal: string, requester: string, signal: AbortSignal): Promise<void> {
    const maxSteps = this.botWrapper.config.maxAgentSteps;
    const history: Array<{ role: 'user' | 'model' | 'assistant'; content: string }> = [];

    const systemPrompt = `
あなたはMinecraftの世界で活動する自律型AIアシスタント（プレイヤー名: ${this.botWrapper.config.mcUsername}）です。
指示された目標（例: 装備作り、建築、討伐準備、素材集め）を達成するために、自分の持ち物と周囲の環境を確認し、1ステップずつ着実にスキル（Tool）を実行してください。

【Minecraft攻略・クラフトの基本進行ルール（最重要）】
1. **鉄鉱石を掘るには「石のツルハシ以上」が必須です！**
   - いきなり鉄鉱石を素手で掘ることはできません（アイテムがドロップせず無駄になります）。
   - 何もない状態なら、必ず以下の順序で進めてください：
     ① まず 'mineAndCollect' で木（wood / log）を掘る
     ② 'craftItem' で木材（oak_planks）、作業台（crafting_table）、棒（stick）を作る
     ③ 'placeBlock' で作業台を置き、'craftItem' で「木のツルハシ (wooden_pickaxe)」を作る
     ④ 'mineAndCollect' で丸石（stone / cobblestone）を掘る
     ⑤ 'craftItem' で「石のツルハシ (stone_pickaxe)」や「石の剣」を作る
     ⑥ 石のツルハシができて初めて「鉄鉱石 (iron_ore)」を採掘する
2. **クラフトの基本**:
   - 3x3のレシピ（ツルハシ、剣、防具、かまど等）は作業台（crafting_table）が必要です。インベントリに作業台があれば自動で設置してクラフトを試みます。
3. **失敗時の自己修復**:
   - アクションが失敗した（ツールが足りない、ブロックが見つからない）という観察結果（Observation）が返ってきたら、即座に指摘された素材集めや下位ツールの作成に切り替えてください。
4. **目標達成まで継続（最重要）**:
   - 資材不足、道具不足、採掘やクラフトの失敗、目標の一部だけができた状態は、タスク完了ではありません。これらを理由に 'finishTask' を呼んではいけません。
   - 不足素材が分かったら、必要数を計算し、'mineAndCollect' で集める、原木を板材や棒に加工する、下位ツールをクラフトする、作業台を設置するなど、依存関係に沿った代替手段を実行してください。
   - 探した場所に素材がなければ周囲を探索・移動して再度探してください。行動結果を毎回確認し、失敗したら方法や場所を変えて再試行してください。
   - 進捗を報告する場合は 'chat' を使い、報告だけでタスクを終了しないでください。
   - 'finishTask' は、最新の環境・インベントリ情報で指示された目標全体の達成を確認できた場合に限って呼び出してください。達成したと推測しただけでは完了にしないでください。
5. **完了報告**:
   - 目標全体の達成を確認したら、'finishTask' ツールで結果を報告してください。最大100ステップに到達した場合のみ、未達成のまま強制停止します。

【狩りと食料確保】
- プレイヤーが「狩りをして」「動物を狩って食料を集めて」などと指示したら、'huntMob' を使ってください。'targetType' は動物だけなら 'animals'、敵対Mobだけなら 'hostiles'、指定がなければ 'any' にします。
- 'huntMob' は近くの対象を探して討伐し、ドロップの回収まで行います。対象が見つからない、または倒せなかった場合は成功したと報告せず、周囲を移動して再探索してください。体力が少ない場合は安全を優先してください。
- ${this.botWrapper.config.autoEat ? '満腹度が15以下なら autoEat がインベントリにある安全な食料を自動で食べます。食料がない時は、依頼に応じて huntMob で動物を狩るか、食料を入手できる別の行動をしてください。' : 'autoEat は設定で無効です。食料が必要なら huntMob で動物を狩るなど、指示に合った方法で食料を確保してください。'}
`.trim();

    // 初期メッセージ
    history.push({
      role: 'user',
      content: `【プレイヤー (${requester}) からの指示】\n"${goal}"\n\n【初期環境状況】\n${this.botWrapper.perception.generateEnvironmentPrompt(goal)}\n\n目標達成のために最初のアクションを実行してください。`,
    });

    let lastActionFailed = false;
    let lastFailureMessage = '';
    let taskCompleted = false;

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) {
        console.log('[Agent] Task was aborted.');
        break;
      }

      // もし自衛戦闘中の場合は敵を倒すまで少し待機
      if (this.botWrapper.guard?.isInCombat()) {
        console.log('[Agent] ⚔️ Bot is currently fighting hostiles for self-defense. Pausing task step...');
        while (this.botWrapper.guard?.isInCombat()) {
          await new Promise(r => setTimeout(r, 500));
        }
        console.log('[Agent] ✅ Combat resolved! Resuming task...');
      }

      console.log(`\n--- [Step ${step}] Thinking... ---`);

      // 1. LLMによる思考とアクション決定
      let llmRes: LLMResponse;
      try {
        llmRes = await this.llmClient.decideNextAction(systemPrompt, history);
      } catch (err: any) {
        console.error('[Agent] LLM API Call Error:', err.message);
        throw err;
      }

      const stepLog: AgentStepLog = {
        timestamp: new Date().toLocaleTimeString(),
        stepNumber: step,
        thought: llmRes.thought,
        actionName: llmRes.toolCall?.name,
        actionParams: llmRes.toolCall?.args,
        status: 'acting',
      };
      this.emit('stepLog', stepLog);

      if (llmRes.thought) {
        console.log(`[Agent Thought]: ${llmRes.thought}`);
      }

      // ツール呼び出しが無い（テキストのみの返答）場合
      if (!llmRes.toolCall) {
        const text = llmRes.textResponse || '了解しました。';
        console.log(`[Agent Chat]: ${text}`);
        await this.botWrapper.skills.chat(text);
        stepLog.status = 'success';
        stepLog.observation = `進捗発言: ${text}。目標の完了はまだ確認されていないため、実行可能な次のアクションを選びます。`;
        this.emit('stepLog', stepLog);
        history.push({ role: 'model', content: text });
        history.push({
          role: 'user',
          content: `進捗の発言だけでは目標は完了していません。最新の所持品と環境を再確認し、目標達成に必要なツールアクションを実行してください。資材が不足していれば採掘・収集・クラフトを続けてください。`,
        });
        if (history.length > 21) history.splice(1, history.length - 21);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      const { name: toolName, args: toolArgs } = llmRes.toolCall;
      console.log(`[Agent Action]: ${toolName}(${JSON.stringify(toolArgs)})`);

      // finishTask ツールが呼ばれた場合
      if (toolName === 'finishTask') {
        const summary = String(toolArgs.resultSummary || '');
        const summaryClaimsBlocker = /(資材|素材|材料|不足|足りない|見つからない|できません|できなかった|未完了|unable|cannot|can't|not enough|insufficient|missing|not completed|unfinished)/i.test(summary);
        if (lastActionFailed || summaryClaimsBlocker) {
          const reason = lastActionFailed
            ? `直前のアクションが失敗しています: ${lastFailureMessage}`
            : `完了理由に未解決の不足または未達成が含まれています: ${summary}`;
          stepLog.status = 'failure';
          stepLog.observation = `完了宣言を拒否しました。${reason}。素材を集める、クラフトする、経路を変えるなど次の行動を続けてください。`;
          this.emit('stepLog', stepLog);
          history.push({ role: 'model', content: `Action: finishTask(${JSON.stringify(toolArgs)})` });
          history.push({ role: 'user', content: `目標は未達成です。${reason}。finishTask は受理されません。環境とインベントリを確認し、必要な素材の採掘・収集、クラフト、移動などのツールを実行してください。` });
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        const completedSummary = summary || '目標を完了しました。';
        await this.botWrapper.skills.chat(`完了報告: ${completedSummary}`);
        stepLog.status = 'finished';
        stepLog.observation = completedSummary;
        this.emit('stepLog', stepLog);
        console.log(`\n========================================`);
        console.log(`[Agent Goal Achieved]: ${completedSummary}`);
        console.log(`========================================\n`);
        taskCompleted = true;
        break;
      }

      // 2. ボットによるアクション実行
      const execResult = await executeBotTool(this.botWrapper, toolName, toolArgs);
      console.log(`[Agent Observation]: ${execResult.success ? '成功' : '失敗'} - ${execResult.message}`);

      stepLog.status = execResult.success ? 'success' : 'failure';
      stepLog.observation = execResult.message;
      this.emit('stepLog', stepLog);
      if (!execResult.success) {
        lastActionFailed = true;
        lastFailureMessage = execResult.message;
      } else if (toolName !== 'chat') {
        lastActionFailed = false;
        lastFailureMessage = '';
      }

      // 3. 環境フィードバックを履歴に追加
      const currentEnv = this.botWrapper.perception.generateEnvironmentPrompt(this.currentTask);
      const observationText = `
【アクション "${toolName}" の実行結果】
${execResult.success ? 'SUCCESS (成功)' : 'FAILED (失敗)'}: ${execResult.message}

【最新の環境・所持品状況】
${currentEnv}

上記の結果を踏まえて、次のアクションを実行するか、完了していれば 'finishTask' を呼び出してください。
`.trim();

      history.push({
        role: 'model',
        content: `Thought: ${llmRes.thought || ''}\nAction: ${toolName}(${JSON.stringify(toolArgs)})`,
      });
      history.push({
        role: 'user',
        content: observationText,
      });

      // ★ 履歴が膨らんでヒープ不足にならないよう、最初の指示 + 直近20件のみ保持
      const MAX_HISTORY = 20;
      if (history.length > MAX_HISTORY + 1) {
        // history[0] は初期指示なので必ず残す
        history.splice(1, history.length - MAX_HISTORY - 1);
      }

      // 各ステップ間に待機（レート制限保護）
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!taskCompleted && !signal.aborted) {
      const message = `最大${maxSteps}ステップに到達したため停止しました。目標は未完了です。タスクを続けるには新しい指示を送ってください。`;
      await this.botWrapper.skills.chat(message);
      this.emit('stepLog', {
        timestamp: new Date().toLocaleTimeString(),
        stepNumber: maxSteps,
        observation: message,
        status: 'failure',
      } as AgentStepLog);
    }
  }

  /**
   * 現在進行中のタスクを中断
   */
  public async cancelTask(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    try {
      if (this.botWrapper.guard && typeof this.botWrapper.guard.stopDefending === 'function') {
        this.botWrapper.guard.stopDefending();
      }
    } catch { }
    await this.botWrapper.skills.stopActions();
    if (this.currentExecutionPromise) {
      await Promise.race([
        this.currentExecutionPromise,
        new Promise(r => setTimeout(r, 1000)),
      ]).catch(() => {});
    }
    this.isProcessing = false;
    this.currentTask = null;
    this.currentExecutionPromise = null;
    this.emit('taskCancelled');
  }

  public restartAIClient(): void {
    this.llmClient = new LLMClient(this.botWrapper.config);
  }

  public getCurrentTask(): string | null {
    return this.currentTask;
  }

  public isBusy(): boolean {
    return this.isProcessing;
  }
}
