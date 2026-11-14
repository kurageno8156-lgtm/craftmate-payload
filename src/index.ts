console.log("START");
// Global error handlers to keep web server alive
process.on('uncaughtException', (err) => {
    console.warn('[System Notice] Suppressed unhandled exception:', err.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.warn('[System Notice] Suppressed unhandled rejection:', reason);
});
import readline from 'readline';
import { config } from './config.js';
import { MinecraftBot } from './bot/mcBot.js';
import { AutonomousAgent } from './ai/agent.js';
import { WebServer } from './server/webServer.js';

console.log(`
======================================================
🤖 Minecraft Autonomous AI Bot System
   Brain: ${config.llmProvider.toUpperCase()} (${config.llmProvider === 'gemini' ? config.geminiModel : config.openaiModel})
   Bot Name: ${config.mcUsername}
   Server: ${config.mcHost}:${config.mcPort}
======================================================
`);

// 1. Mineflayer Bot インスタンス初期化
const botWrapper = new MinecraftBot(config);

// 2. 自律AIエージェントの初期化
const agent = new AutonomousAgent(botWrapper);

// 3. Webダッシュボードサーバーの起動
const webServer = new WebServer(botWrapper, agent, config.webPort);
webServer.start();

// 4. Minecraft Bot 接続開始
botWrapper.start();

// 5. CLIコンソールからの直接入力受付
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on('line', (line: string) => {
  const text = line.trim();
  if (!text) return;

  if (text.toLowerCase() === 'stop' || text === 'ストップ') {
    console.log('[CLI] Stopping current task...');
    agent.cancelTask();
  } else if (text.toLowerCase() === 'status') {
    console.log('[CLI] Current Status:', JSON.stringify(botWrapper.getStatus(agent.getCurrentTask(), agent.isBusy()), null, 2));
  } else {
    console.log(`[CLI] Received instruction: "${text}"`);
    agent.handleInstruction(text, 'ConsoleUser');
  }
});

// 終了シグナルハンドリング
process.on('SIGINT', async () => {
  console.log('\n[System] Shutting down AI Bot gracefully...');
  await agent.cancelTask();
  if (botWrapper.bot) {
    // Safely quit the bot – fallback if quit() is not available
    if (typeof (botWrapper.bot as any).quit === 'function') {
      (botWrapper.bot as any).quit();
    } else if (typeof (botWrapper.bot as any).end === 'function') {
      (botWrapper.bot as any).end();
    } else if (typeof (botWrapper.bot as any).disconnect === 'function') {
      (botWrapper.bot as any).disconnect();
    } else {
      console.warn('[System] Bot object has no quit/end/disconnect method.');
    }
  }
  process.exit(0);
});
