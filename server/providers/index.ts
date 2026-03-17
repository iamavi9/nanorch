export type Provider = "openai" | "anthropic" | "gemini" | "ollama";

export interface ProviderMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
}

export interface RunAgentOptions {
  provider: Provider;
  model: string;
  baseUrl?: string | null;
  systemPrompt?: string | null;
  messages: ProviderMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  onChunk?: (chunk: string) => void;
}

export interface RunAgentResult {
  content: string;
  toolCalls?: ToolCall[];
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  description: string;
}

export const PROVIDER_MODELS: Record<Provider, ProviderModelInfo[]> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o", description: "Most capable multimodal model" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Fast and affordable" },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo", description: "Previous generation GPT-4" },
  ],
  anthropic: [
    { id: "claude-opus-4-5", name: "Claude Opus 4.5", description: "Most capable Claude model" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", description: "Balanced performance" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fast and lightweight" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Most capable Gemini model" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast and efficient" },
  ],
  ollama: [
    { id: "llama3.1", name: "Llama 3.1", description: "Meta's Llama 3.1 (tool calling supported)" },
    { id: "llama3.2", name: "Llama 3.2", description: "Meta's Llama 3.2" },
    { id: "qwen2.5", name: "Qwen 2.5", description: "Alibaba Qwen 2.5 (tool calling supported)" },
    { id: "mistral", name: "Mistral", description: "Mistral 7B" },
    { id: "codellama", name: "Code Llama", description: "Code-focused Llama model" },
    { id: "deepseek-r1", name: "DeepSeek R1", description: "DeepSeek reasoning model" },
  ],
};

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  switch (options.provider) {
    case "openai": {
      const { runOpenAI } = await import("./openai");
      return runOpenAI(options);
    }
    case "anthropic": {
      const { runAnthropic } = await import("./anthropic");
      return runAnthropic(options);
    }
    case "gemini": {
      const { runGemini } = await import("./gemini");
      return runGemini(options);
    }
    case "ollama": {
      const { runOllama } = await import("./ollama");
      return runOllama(options);
    }
    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
