import { MinecraftBot } from '../bot/mcBot.js';
import { LLMClient, LLMResponse } from './llmClient.js';
import { executeBotTool } from './tools.js';
import { AgentStepLog, ChatMessage } from '../types.js';
import { EventEmitter } from 'events';

const ACTION_GOAL_PATTERN = /採掘|掘|伐|切|作|クラフト|建|設置|置|取|集め|狩|殺|倒|行|探|拾|mine|craft|build|place|chop|dig|gather|hunt|kill|attack|fight|fetch|get|make|find|go to/i;

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
      // タスクの完了は待たずにキューを解放する。
      // 待つと、長時間ツール実行中に届いた新しい指示が前タスク終了まで遅延してしまうため。
      // 割り込みは runNext 先頭の cancelTask が担当する。
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
 | あなたはMinecraftの世界で活動する自律型AIアシスタント（プレイヤー名: ${this.botWrapper.config.mcUsername}）です。
 | 回答は必ず簡潔に、1〜3文で答えてください。
 | 指示された目標（例: 装備作り、建築、討伐準備、素材集め）を達成するために、自分の持ち物と周囲の環境を確認し、1ステップずつ着実にスキル（Tool）を実行してください。


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

【チャット・雑談のルール（最重要）】
- 挨拶や雑談（「こんにちは」「あなたは誰」「英語で話して」など）や質問には、チャットで1回だけ返答し、直ちに 'finishTask' を呼んでタスクを終了してください。雑談や質問に作業ツール（採掘・クラフト等）は不要です。
- 1つのタスクにつきチャット送信は最大2回までです（開始時の一言と完了時の報告のみ）。同じ内容・類似内容のチャットを連続で送ったり、途中経過を何度も報告したりしてはいけません。
- ツールを呼び出す際は、thought には内部の思考過程ではなく「これから何をするか」をユーザーに伝える自然な一言を1〜2文で書いてください（例:「了解！木を10個集めてくるね。ちょっと待ってて！」）。この一言はそのままチャットとして送信されるので、ユーザーに向けた話し言葉で書いてください。
- AutoGuard（自動防御）が敵と戦っている間は、チャットを送らず防御行動に専念してください。戦闘終了後に結果を報告してください。
- 'finishTask' を呼ぶ際は、resultSummary に「何をどれだけ達成したか」をユーザーに伝える自然な完了報告を1〜2文で書いてください（例:「お待たせ！木を10個集めたよ。他に何か必要なものはある？」）。この文章はそのままチャットとして送信されます。
- 「昼にして」「夜にして」「テレポートして」「時間を止めて」などワールド操作の指示には 'executeCommand' ツールを使ってください（例: "time set day"、"time set night"、"tp @p x y z"）。
- 「コマンドブロックを置いて」「座標にコマンドブロックを設置」などの指示には 'placeCommandBlock'（引数: x, y, z, command, commandType）を使い、発動が必要なら 'triggerCommandBlock' も使ってください。
- コマンドブロックの実行結果を確認したい場合は 'getCommandBlockHistory' ツールを使ってください。同じコマンドを繰り返す前に、必ず前回の結果を確認してください。

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
    const MAX_CHATS_PER_TASK = 2;
    let chatCount = 0;
    let blockedChatCount = 0;
    const guardActive = () => !!(this.botWrapper.guard && this.botWrapper.guard.isInCombat());

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
        stepLog.status = 'success';

        // AutoGuard戦闘中はチャットを送らない
        if (guardActive()) {
          stepLog.observation = 'AutoGuardが敵と戦闘中のため、チャットは送信されませんでした。';
          this.emit('stepLog', stepLog);
          history.push({ role: 'model', content: text });
          history.push({ role: 'user', content: '現在AutoGuardが敵と戦闘中です。チャットは送らず、戦闘終了を待ってから次のアクションを実行してください。' });
          if (history.length > 21) history.splice(1, history.length - 21);
          await new Promise(r => setTimeout(r, 50));
          continue;
        }

        // チャット上限超過 → 強制終了（チャット連投の根本対策）
        if (chatCount >= MAX_CHATS_PER_TASK) {
          taskCompleted = true;
          stepLog.status = 'finished';
          stepLog.observation = `チャット送信上限に達したためタスクを終了しました: ${text}`;
          this.emit('stepLog', stepLog);
          console.log(`\n========================================`);
          console.log(`[Agent Task Finished]: ${text}`);
          console.log(`========================================\n`);
          break;
        }

        await this.botWrapper.skills.chat(text);
        chatCount++;

        // 雑談・質問（作業指示を含まない目標）には1回の返答で即終了し、余分なLLM呼び出しを省略する
        if (!ACTION_GOAL_PATTERN.test(goal)) {
          taskCompleted = true;
          stepLog.status = 'finished';
          stepLog.observation = `雑談・質問への返答を送信しました: ${text}`;
          this.emit('stepLog', stepLog);
          console.log(`\n========================================`);
          console.log(`[Agent Task Finished]: ${text}`);
          console.log(`========================================\n`);
          break;
        }

        stepLog.observation = `発言: ${text}。チャットは送信済みです。追加のチャットは最小限にし、目標が達成済みなら 'finishTask'、未達成なら作業ツールを実行してください。`;
        this.emit('stepLog', stepLog);
        history.push({ role: 'model', content: text });
        history.push({
          role: 'user',
          content: `あなたは「${text}」と発言しました。これ以上チャットは原則送らないでください。目標が達成済みなら 'finishTask' を呼んで終了し、未達成なら必要な作業ツールを実行してください。`,
        });
        if (history.length > 21) history.splice(1, history.length - 21);
        await new Promise(r => setTimeout(r, 50));
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
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        const completedSummary = summary || '目標を完了しました。';
        // チャット上限・戦闘中は完了報告のチャットを送らない
        if (!guardActive() && chatCount < MAX_CHATS_PER_TASK) {
          await this.botWrapper.skills.chat(completedSummary);
          chatCount++;
        }
        stepLog.status = 'finished';
        stepLog.observation = completedSummary;
        this.emit('stepLog', stepLog);
        console.log(`\n========================================`);
        console.log(`[Agent Goal Achieved]: ${completedSummary}`);
        console.log(`========================================\n`);
        taskCompleted = true;
        break;
      }

      // 'chat' ツールの連投・戦闘中送信をブロック
      if (toolName === 'chat') {
        if (guardActive()) {
          stepLog.status = 'success';
          stepLog.observation = 'AutoGuardが敵と戦闘中のため、チャットは送信されませんでした。防御行動を優先してください。';
          this.emit('stepLog', stepLog);
          history.push({ role: 'model', content: `Action: chat(${JSON.stringify(toolArgs)})` });
          history.push({ role: 'user', content: '【アクション "chat" の実行結果】\nSKIPPED: AutoGuardが敵と戦闘中のためチャットは送信されませんでした。チャットは送らず、戦闘終了を待つか次の作業ツールを実行してください。' });
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        if (chatCount >= MAX_CHATS_PER_TASK) {
          blockedChatCount++;
          stepLog.status = 'failure';
          stepLog.observation = 'チャット送信上限（1タスクにつき最大2回）に達したためブロックしました。';
          this.emit('stepLog', stepLog);
          history.push({ role: 'model', content: `Action: chat(${JSON.stringify(toolArgs)})` });
          if (blockedChatCount >= 2) {
            taskCompleted = true;
            console.log(`\n========================================`);
            console.log('[Agent Task Finished]: チャット連投のため強制終了しました。');
            console.log(`========================================\n`);
            break;
          }
          history.push({ role: 'user', content: 'チャットはこのタスクの送信上限に達しています。チャットを送らず、目標が達成済みなら \'finishTask\' を呼び、未達成なら作業ツールを実行してください。' });
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
      }

      // 実行前の宣言（必須）：タスク最初の実動作ツールに対し、LLMのthoughtを優先して開始の一言をチャット送信。
      // thoughtが空の場合でもユーザーに必ず状況を伝えるフォールバック発言を送る。
      if (chatCount === 0 && !guardActive() && toolName !== 'chat') {
        const shortGoal = goal.length > 30 ? goal.slice(0, 30) + '…' : goal;
        let remark = (llmRes.thought || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        // thoughtが空の場合はAIに開始の一言を生成させる（定型文は最終手段）
        if (!remark) {
          try {
            remark = (await this.llmClient.chatOnce(
              `あなたはMinecraftのボットです。プレイヤーから「${shortGoal}」という指示を受け、これからツール「${toolName}」を実行します。` +
              `プレイヤーに向けて、これから何をするかを伝える自然な一言を1〜2文だけ返してください（敬語は使わずフレンドリーに。説明や記号は不要）。`
            )).replace(/\s+/g, ' ').trim().slice(0, 200);
          } catch { remark = ''; }
        }
        remark = remark || `了解！これから「${shortGoal}」に取りかかるね。少し待ってて！`;
        const remarkResult = await this.botWrapper.skills.chat(remark);
        if (remarkResult.success) {
          chatCount++;
          stepLog.observation = `開始の発言: ${remark}`;
          this.emit('stepLog', stepLog);
          console.log(`[Agent Remark]: ${remark}`);
        }
      }

      // 2. ボットによるアクション実行（宣言の後にバックグラウンドで開始）
      const execPromise = executeBotTool(this.botWrapper, toolName, toolArgs);
      execPromise.catch(() => { /* await側でハンドリングする */ });

      const execResult = await execPromise;
      console.log(`[Agent Observation]: ${execResult.success ? '成功' : '失敗'} - ${execResult.message}`);

      stepLog.status = execResult.success ? 'success' : 'failure';
      stepLog.observation = execResult.message;
      this.emit('stepLog', stepLog);
      if (!execResult.success) {
        lastActionFailed = true;
        lastFailureMessage = execResult.message;
      } else if (toolName === 'chat') {
        chatCount++;
        blockedChatCount = 0;
      } else {
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
       // 各ステップ間に待機（レート制限保護）
       await new Promise(r => setTimeout(r, 50));
      }

      // 各ステップ間に待機（レート制限保護）
      await new Promise(r => setTimeout(r, 50));
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
