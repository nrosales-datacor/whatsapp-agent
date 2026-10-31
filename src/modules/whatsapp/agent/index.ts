// API del agente de IA dentro del módulo whatsapp: la composición (src/jobs.ts) crea el
// runner con `createAgentRunner()` y lo inyecta al pipeline de mensajes (contrato en
// ../agentContract.ts). Lo demás se exporta para los tests y las evals (eval/).
export { createAgentRunner, buildMessages, cutToLastSentence, isContextOverflowError } from "./runner";
export type { AgentRunnerDeps, ChatCompletionsClient, ToolCallEvent } from "./runner";
export { loadAgentContext, priceText } from "./context";
export type { AgentContext, AgentLocation, AgentService, AgentStaff } from "./context";
export { buildSystemPrompt, buildTurnContext, estimatePromptChars, fitSystemPrompt, hoursText, promptBudgetProblem } from "./prompt";
export type { FittedPrompt, PromptTrim } from "./prompt";
export { maxSystemPromptChars } from "./config";
export { historyToMessages, trimHistory } from "./history";
export { computeCostMicros, MODEL_PRICING, pricingFor } from "./cost";
export type { ModelPricing, TokenUsage } from "./cost";
export { emptyEffects, executeTool, freeText, GENERIC_TOOL_ERROR, TOOL_DEFINITIONS, TOOL_NAMES } from "./tools";
export type { ToolResult, ToolRuntime, TurnEffects } from "./tools";
export { AGENT_TEXT_KEYS, AGENT_TEXTS, agentText, isOutOfScopeReply } from "./texts";
export type { AgentTextKey } from "./texts";
