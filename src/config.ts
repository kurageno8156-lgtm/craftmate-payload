import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface BotConfig {
  // Minecraft Connection
  mcHost: string;
  mcPort: number;
  mcUsername: string;
  mcVersion?: string;
  mcAuth: 'offline' | 'microsoft';

  // AI Brain Settings
  llmProvider: 'gemini' | 'openai' | 'ollama';
  geminiApiKey?: string;
  geminiModel: string;
  openaiApiKey?: string;
  openaiModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;

  // Web Dashboard
  webPort: number;

  // Agent behavior
  maxAgentSteps: number;
  autoEat: boolean;
  autoArmor: boolean;
}

export const config: BotConfig = {
  mcHost: process.env.MC_HOST || 'localhost',
  mcPort: parseInt(process.env.MC_PORT || '25565', 10),
  mcUsername: process.env.MC_USERNAME || 'AI_Worker',
  mcVersion: process.env.MC_VERSION || undefined,
  mcAuth: (process.env.MC_AUTH as 'offline' | 'microsoft') || 'offline',

  llmProvider: (process.env.LLM_PROVIDER as 'gemini' | 'openai' | 'ollama') || 'gemini',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',

  webPort: parseInt(process.env.WEB_PORT || '3000', 10),
  maxAgentSteps: process.env.MAX_AGENT_STEPS ? parseInt(process.env.MAX_AGENT_STEPS, 10) : Number.MAX_SAFE_INTEGER,
  autoEat: process.env.AUTO_EAT !== 'false',
  autoArmor: process.env.AUTO_ARMOR !== 'false',
};
