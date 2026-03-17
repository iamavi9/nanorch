/**
 * NanoOrch Agent Sandbox Runner
 *
 * Runs inside an ephemeral Docker container. Receives task configuration
 * via environment variables, executes ONE round of AI inference (with or
 * without tool definitions), and outputs structured JSON to stdout.
 *
 * Outputs one of:
 *   { type: "log",        level, message }         — progress line
 *   { type: "tool_calls", toolCalls, assistantContent } — AI wants tools
 *   { type: "result",     output }                 — final answer
 *   { type: "error",      message }                — fatal error
 *
 * Environment Variables:
 *   TASK_ID           - Unique task identifier
 *   PROVIDER          - openai | anthropic | gemini
 *   MODEL             - Model ID
 *   SYSTEM_PROMPT     - System instructions
 *   MAX_TOKENS        - Max output tokens (default 4096)
 *   TEMPERATURE       - Temperature 0-100 scale (default 70)
 *   MESSAGES_JSON     - Base64-encoded JSON array of { role, content } messages
 *   TOOLS_JSON        - Base64-encoded JSON array of tool definitions
 *   OPENAI_API_KEY / OPENAI_BASE_URL
 *   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 *   GEMINI_API_KEY    / GEMINI_BASE_URL
 */

const {
  TASK_ID = "unknown",
  PROVIDER = "openai",
  MODEL = "gpt-4o",
  SYSTEM_PROMPT = "",
  MAX_TOKENS = "4096",
  TEMPERATURE = "70",
  MESSAGES_JSON,
  TOOLS_JSON,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
} = process.env;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(level, message) {
  emit({ type: "log", level, message, timestamp: new Date().toISOString() });
}

function decodeB64Json(b64, fallback) {
  if (!b64) return fallback;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return fallback;
  }
}

const messages = decodeB64Json(MESSAGES_JSON, []);
const tools = decodeB64Json(TOOLS_JSON, []);
const maxTokens = parseInt(MAX_TOKENS);
const temperature = parseInt(TEMPERATURE) / 100;

async function runOpenAI() {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL || undefined,
  });

  const chatMessages = [];
  if (SYSTEM_PROMPT) chatMessages.push({ role: "system", content: SYSTEM_PROMPT });
  chatMessages.push(...messages);

  const params = {
    model: MODEL,
    messages: chatMessages,
    max_completion_tokens: maxTokens,
    temperature,
  };

  if (tools.length > 0) {
    params.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    params.tool_choice = "auto";
  }

  log("info", `Calling OpenAI ${MODEL}`);
  const response = await openai.chat.completions.create(params);
  const choice = response.choices[0];
  const msg = choice.message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const toolCalls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: (() => {
        try { return JSON.parse(tc.function.arguments); } catch { return {}; }
      })(),
    }));
    emit({ type: "tool_calls", toolCalls, assistantContent: msg.content ?? "" });
  } else {
    emit({ type: "result", output: msg.content ?? "" });
  }
}

async function runAnthropic() {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const anthropic = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    baseURL: ANTHROPIC_BASE_URL || undefined,
  });

  const chatMessages = messages.filter((m) => m.role !== "system");

  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    system: SYSTEM_PROMPT || undefined,
    messages: chatMessages,
  };

  if (tools.length > 0) {
    params.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  log("info", `Calling Anthropic ${MODEL}`);
  const response = await anthropic.messages.create(params);

  const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
  const textBlock = response.content.find((b) => b.type === "text");

  if (toolUseBlocks.length > 0) {
    const toolCalls = toolUseBlocks.map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input ?? {},
    }));
    emit({ type: "tool_calls", toolCalls, assistantContent: textBlock?.text ?? "" });
  } else {
    emit({ type: "result", output: textBlock?.text ?? "" });
  }
}

async function runGemini() {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY,
    httpOptions: {
      apiVersion: "",
      baseUrl: GEMINI_BASE_URL || undefined,
    },
  });

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const params = {
    model: MODEL,
    contents,
    config: {
      maxOutputTokens: maxTokens,
      temperature,
      systemInstruction: SYSTEM_PROMPT ? { parts: [{ text: SYSTEM_PROMPT }] } : undefined,
    },
  };

  if (tools.length > 0) {
    params.config.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];
  }

  log("info", `Calling Gemini ${MODEL}`);
  const response = await ai.models.generateContent(params);

  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const functionCallParts = parts.filter((p) => p.functionCall);
  const textParts = parts.filter((p) => p.text);

  if (functionCallParts.length > 0) {
    const toolCalls = functionCallParts.map((p, i) => ({
      id: `gemini-call-${i}`,
      name: p.functionCall.name,
      arguments: p.functionCall.args ?? {},
    }));
    emit({ type: "tool_calls", toolCalls, assistantContent: textParts.map((p) => p.text).join("") });
  } else {
    emit({ type: "result", output: textParts.map((p) => p.text).join("") ?? response.text ?? "" });
  }
}

async function main() {
  log("info", `Agent sandbox started — task: ${TASK_ID}, provider: ${PROVIDER}, tools: ${tools.length}`);

  switch (PROVIDER) {
    case "openai":
      await runOpenAI();
      break;
    case "anthropic":
      await runAnthropic();
      break;
    case "gemini":
      await runGemini();
      break;
    default:
      throw new Error(`Unknown provider: ${PROVIDER}`);
  }
}

main().catch((err) => {
  emit({ type: "error", message: err?.message ?? String(err) });
  process.exit(1);
});
