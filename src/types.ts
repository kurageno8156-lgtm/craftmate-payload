export interface BotStatus {
  health: number;
  food: number;
  position: { x: number; y: number; z: number };
  dimension: string;
  gameTime: string;
  biome: string;
  inventory: Array<{ name: string; count: number; displayName: string }>;
  heldItem: string | null;
  equippedArmor: {
    helmet?: string;
    chestplate?: string;
    leggings?: string;
    boots?: string;
  };
  nearbyEntities: Array<{
    name: string;
    type: string;
    distance: number;
    position: { x: number; y: number; z: number };
    isHostile: boolean;
    isPlayer: boolean;
  }>;
  nearbyBlocksSummary: Record<string, number>;
  currentTask: string | null;
  isExecuting: boolean;
}

export interface AgentStepLog {
  timestamp: string;
  stepNumber: number;
  thought?: string;
  actionName?: string;
  actionParams?: Record<string, any>;
  observation?: string;
  status: 'thinking' | 'acting' | 'success' | 'failure' | 'finished';
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
  isBot: boolean;
  isSystem?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}

export interface ToolCallResult {
  success: boolean;
  message: string;
  data?: any;
}
