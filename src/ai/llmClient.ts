import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import OpenAI from 'openai';
import { BotConfig } from '../config.js';
import { BOT_TOOLS } from './tools.js';

export interface LLMResponse {
  thought?: string;
  toolCall?: {
    name: string;
    args: Record<string, any>;
  };
  textResponse?: string;
}

/**
 * モデルがテキスト形式で Action を出力してしまった場合のフォールバックパーサー
 */
function parseToolCallFromText(text: string): { toolCall?: { name: string; args: Record<string, any> }; cleanThought?: string } {
  if (!text) return {};

  const knownTools = BOT_TOOLS.map(t => t.name);

  // パターン1: Action: toolName({"arg": "val"}) または toolName({"arg": "val"})
  for (const toolName of knownTools) {
    const regex = new RegExp(`(?:Action:\\s*)?${toolName}\\s*\\((\\{[\\s\\S]*?\\})\\)`, 'i');
    const match = text.match(regex);
    if (match) {
      try {
        const args = JSON.parse(match[1]);
        const cleanThought = text.replace(match[0], '').trim();
        return {
          toolCall: { name: toolName, args },
          cleanThought: cleanThought || undefined,
        };
      } catch {
        // ignore JSON parse error
      }
    }
  }

  // パターン2: ```json { "action": "toolName", "args": {...} } ``` または { "name": "toolName", "args": {...} }
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const jsonMatch = text.match(jsonBlockRegex);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const name = parsed.action || parsed.name || parsed.tool;
      const args = parsed.args || parsed.parameters || parsed.arguments || {};
      if (name && knownTools.includes(name)) {
        const cleanThought = text.replace(jsonMatch[0], '').trim();
        return {
          toolCall: { name, args },
          cleanThought: cleanThought || undefined,
        };
      }
    } catch {
      // ignore
    }
  }

  return {};
}

/**
 * 429エラー文字列から待機秒数を抽出
 */
function extractRetryDelaySeconds(errorMsg: string): number {
  // 例: "Please retry in 38.34s" または "retryDelay":"38s"
  const match1 = errorMsg.match(/retry in\s+([0-9.]+)\s*s/i);
  if (match1) {
    return Math.ceil(parseFloat(match1[1])) + 1;
  }
  const match2 = errorMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
  if (match2) {
    return parseInt(match2[1], 10) + 1;
  }
  return 10; // デフォルト10秒
}

export class LLMClient {
  private config: BotConfig;
  private geminiAi: GoogleGenerativeAI | null = null;
  private openAiClient: OpenAI | null = null;
  private lastRequestTime: number = 0;
  private minRequestIntervalMs: number = 2500; // 1分間に最大24回以下に制限（15 RPM無料制限を保護）

  constructor(config: BotConfig) {
    this.config = config;

    if (this.config.llmProvider === 'gemini' && this.config.geminiApiKey) {
      this.geminiAi = new GoogleGenerativeAI(this.config.geminiApiKey);
    } else if (this.config.llmProvider === 'openai' && this.config.openaiApiKey) {
      this.openAiClient = new OpenAI({ apiKey: this.config.openaiApiKey });
    } else if (this.config.llmProvider === 'groq' && this.config.groqApiKey) {
      this.openAiClient = new OpenAI({
        apiKey: this.config.groqApiKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
    } else if (this.config.llmProvider === 'ollama') {
      this.openAiClient = new OpenAI({
        baseURL: this.config.ollamaBaseUrl,
        apiKey: 'ollama',
      });
    }
  }

  /**
   * レート制限保護のための間隔制御
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestIntervalMs) {
      const waitTime = this.minRequestIntervalMs - elapsed;
      await new Promise(r => setTimeout(r, waitTime));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * LLMに推論をリクエストし、次のアクション(Tool Call)または回答を取得する
   */
  public async decideNextAction(
    systemPrompt: string,
    history: Array<{ role: 'user' | 'model' | 'assistant'; content: string }>
  ): Promise<LLMResponse> {
    await this.enforceRateLimit();

    if (this.config.llmProvider === 'gemini') {
      return this.callGemini(systemPrompt, history);
    } else {
      return this.callOpenAI(systemPrompt, history);
    }
  }

  /**
   * Google Gemini API 呼び出し（レート制限自動待機＆リトライ付き）
   */
  private async callGemini(
    systemPrompt: string,
    history: Array<{ role: 'user' | 'model' | 'assistant'; content: string }>
  ): Promise<LLMResponse> {
    if (!this.geminiAi) {
      if (!this.config.geminiApiKey) {
        throw new Error('GEMINI_API_KEY が設定されていません。.env ファイルを確認してください。');
      }
      this.geminiAi = new GoogleGenerativeAI(this.config.geminiApiKey);
    }

    const functionDeclarations = BOT_TOOLS.map(tool => {
      const properties: Record<string, any> = {};
      const required: string[] = tool.parameters.required || [];

      for (const [key, prop] of Object.entries(tool.parameters.properties)) {
        let type = SchemaType.STRING;
        if (prop.type === 'number') type = SchemaType.NUMBER;
        if (prop.type === 'boolean') type = SchemaType.BOOLEAN;
        if (prop.type === 'array') type = SchemaType.ARRAY;

        properties[key] = {
          type,
          description: prop.description,
        };
      }

      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties,
          required,
        },
      };
    });

    const candidateModels = [
      this.config.geminiModel,
      'gemini-3.1-flash-lite',
      'gemini-3.1-flash-lite-preview',
      'gemini-3-flash-preview',
      'gemini-3.7-flash',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
    ].filter((v, i, a) => a.indexOf(v) === i);

    let lastError: any = null;
    let result: any = null;

    // まず全候補モデルを順番に即座に試す（モデルごとに個別の無料枠があるため）
    for (const modelName of candidateModels) {
      try {
        console.log(`[LLM] Requesting Gemini model: ${modelName}...`);
        const model = this.geminiAi.getGenerativeModel({
          model: modelName,
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: functionDeclarations as any }],
        });

        const contents = history.map(h => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }],
        }));

        result = await model.generateContent({ contents });
        if (modelName !== this.config.geminiModel) {
          console.log(`[LLM] Switched to working model: ${modelName}`);
          this.config.geminiModel = modelName;
        }
        break; // 成功
      } catch (err: any) {
        lastError = err;
        const msg = (err.message || '').toLowerCase();

        // 429(制限), 404(未存在), 503(一時的混雑), 500等の場合は即座に次の別モデルへ切り替えて試行
        if (
          msg.includes('429') ||
          msg.includes('quota') ||
          msg.includes('too many requests') ||
          msg.includes('resource_exhausted') ||
          msg.includes('404') ||
          msg.includes('not found') ||
          msg.includes('no longer available') ||
          msg.includes('503') ||
          msg.includes('service unavailable') ||
          msg.includes('high demand') ||
          msg.includes('overloaded') ||
          msg.includes('500') ||
          msg.includes('internal error')
        ) {
          console.warn(`[LLM] Model "${modelName}" hit temporary error/rate limit (${err.message.substring(0, 100)}...). Switching immediately to next model...`);
          continue;
        }
        throw err;
      }
    }

    // 全モデルがレート制限に達していた場合のみ、少し待機して1度だけ再試行
    if (!result && lastError) {
      const delaySec = extractRetryDelaySeconds(lastError.message || '');
      console.warn(`[LLM] ⏳ All candidate models hit rate limit. Waiting ${delaySec}s before fallback retry...`);
      await new Promise(r => setTimeout(r, delaySec * 1000));

      for (const modelName of candidateModels) {
        try {
          const model = this.geminiAi.getGenerativeModel({
            model: modelName,
            systemInstruction: systemPrompt,
            tools: [{ functionDeclarations: functionDeclarations as any }],
          });
          const contents = history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }],
          }));
          result = await model.generateContent({ contents });
          this.config.geminiModel = modelName;
          break;
        } catch {
          // continue
        }
      }
    }

    if (!result) {
      throw lastError || new Error('利用可能なGeminiモデルが見つかりませんでした。');
    }
    const response = result.response;
    const candidates = response.candidates;

    if (!candidates || candidates.length === 0) {
      return { textResponse: response.text() };
    }

    const firstCandidate = candidates[0];
    const parts = firstCandidate.content.parts;

    let thought = '';
    let toolCall: LLMResponse['toolCall'] = undefined;

    for (const part of parts) {
      if (part.text) {
        thought += part.text;
      }
      if (part.functionCall) {
        toolCall = {
          name: part.functionCall.name,
          args: part.functionCall.args as Record<string, any>,
        };
      }
    }

    // テキストからのフォールバック抽出
    if (!toolCall && thought) {
      const extracted = parseToolCallFromText(thought);
      if (extracted.toolCall) {
        console.log(`[LLM] Extracted Tool Call from text: ${extracted.toolCall.name}(${JSON.stringify(extracted.toolCall.args)})`);
        toolCall = extracted.toolCall;
        thought = extracted.cleanThought || '';
      }
    }

    return {
      thought: thought.trim() || undefined,
      toolCall,
      textResponse: toolCall ? undefined : (thought.trim() || undefined),
    };
  }

  /**
   * OpenAI / Ollama API 呼び出し
   */
  private async callOpenAI(
    systemPrompt: string,
    history: Array<{ role: 'user' | 'model' | 'assistant'; content: string }>
  ): Promise<LLMResponse> {
    if (!this.openAiClient) {
      if (this.config.llmProvider === 'openai' && !this.config.openaiApiKey) {
        throw new Error('OPENAI_API_KEY is not configured. Check the .env file.');
      }
      if (this.config.llmProvider === 'groq' && !this.config.groqApiKey) {
        throw new Error('GROQ_API_KEY is not configured. Check the .env file.');
      }
      this.openAiClient = new OpenAI({
        apiKey: this.config.llmProvider === 'groq'
          ? this.config.groqApiKey || ''
          : this.config.openaiApiKey || 'ollama',
        baseURL: this.config.llmProvider === 'ollama'
          ? this.config.ollamaBaseUrl
          : this.config.llmProvider === 'groq'
            ? 'https://api.groq.com/openai/v1'
            : undefined,
      });
    }

    const tools: OpenAI.ChatCompletionTool[] = BOT_TOOLS.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({
        role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant',
        content: h.content,
      })),
    ];

    const modelName = this.config.llmProvider === 'ollama'
      ? this.config.ollamaModel
      : this.config.llmProvider === 'groq'
        ? this.config.groqModel
        : this.config.openaiModel;

    const completion = await this.openAiClient.chat.completions.create({
      model: modelName,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const choice = completion.choices[0];
    const message = choice.message;

    let thought = message.content || '';
    let toolCall: LLMResponse['toolCall'] = undefined;

    if (message.tool_calls && message.tool_calls.length > 0) {
      const call = message.tool_calls[0];
      if (call.type === 'function') {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }
        toolCall = {
          name: call.function.name,
          args,
        };
      }
    }

    // テキストからのフォールバック抽出
    if (!toolCall && thought) {
      const extracted = parseToolCallFromText(thought);
      if (extracted.toolCall) {
        toolCall = extracted.toolCall;
        thought = extracted.cleanThought || '';
      }
    }

    return {
      thought: thought.trim() || undefined,
      toolCall,
      textResponse: toolCall ? undefined : (thought.trim() || undefined),
    };
  }
}
