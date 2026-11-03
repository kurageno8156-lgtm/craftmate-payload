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
    if (this.isProcessing) {
      // 進行中のタスクがある場合は停止して新しいタスクを受け付ける
      console.log(`[Agent] Interrupting previous task for new instruction: "${instruction}"`);
      await this.cancelTask();
    }

    this.isProcessing = true;
    this.currentTask = instruction;
    this.abortController = new AbortController();

    this.emit('taskStarted', { task: instruction, requester });
    console.log(`\n========================================`);
    console.log(`[Agent] New Goal from ${requester}: "${instruction}"`);
    console.log(`========================================\n`);

    try {
      await this.runReActLoop(instruction, requester);
    } catch (err: any) {
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
      this.isProcessing = false;
      this.currentTask = null;
      this.emit('taskFinished', { task: instruction });
    }
  }

  /**
   * 自律ReAct実行ループ
   */
  private async runReActLoop(goal: string, requester: string): Promise<void> {
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
4. **完了報告**:
   - 目標が完了したら、必ず 'finishTask' ツールを呼んで完了を報告してください。
`.trim();

    // 初期メッセージ
    history.push({
      role: 'user',
      content: `【プレイヤー (${requester}) からの指示】\n"${goal}"\n\n【初期環境状況】\n${this.botWrapper.perception.generateEnvironmentPrompt(goal)}\n\n目標達成のために最初のアクションを実行してください。`,
    });

    for (let step = 1; step <= maxSteps; step++) {
      if (this.abortController?.signal.aborted) {
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
        stepLog.status = 'finished';
        stepLog.observation = `発言: ${text}`;
        this.emit('stepLog', stepLog);
        break;
      }

      const { name: toolName, args: toolArgs } = llmRes.toolCall;
      console.log(`[Agent Action]: ${toolName}(${JSON.stringify(toolArgs)})`);

      // finishTask ツールが呼ばれた場合
      if (toolName === 'finishTask') {
        const summary = toolArgs.resultSummary || '目標を完了しました！';
        await this.botWrapper.skills.chat(`完了報告: ${summary}`);
        stepLog.status = 'finished';
        stepLog.observation = summary;
        this.emit('stepLog', stepLog);
        console.log(`\n========================================`);
        console.log(`[Agent Goal Achieved]: ${summary}`);
        console.log(`========================================\n`);
        break;
      }

      // 2. ボットによるアクション実行
      const execResult = await executeBotTool(this.botWrapper, toolName, toolArgs);
      console.log(`[Agent Observation]: ${execResult.success ? '成功' : '失敗'} - ${execResult.message}`);

      stepLog.status = execResult.success ? 'success' : 'failure';
      stepLog.observation = execResult.message;
      this.emit('stepLog', stepLog);

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
  }

  /**
   * 現在進行中のタスクを中断
   */
  public async cancelTask(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    await this.botWrapper.skills.stopActions();
    this.isProcessing = false;
    this.currentTask = null;
    this.emit('taskCancelled');
  }

  public getCurrentTask(): string | null {
    return this.currentTask;
  }

  public isBusy(): boolean {
    return this.isProcessing;
  }
}
