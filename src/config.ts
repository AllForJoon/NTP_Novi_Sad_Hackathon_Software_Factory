import { supportedModels } from '@mozaik-ai/core';
import type { Role } from './schemas.js';

export interface FactoryConfig {
  provider: 'auto' | 'jigjoy' | 'openai' | 'anthropic' | 'gemini';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  models: Record<Role, string>; maxRetries: number; maxProviderRetries: number; maxPlanningRetries: number;
  maxModelCalls: number; maxOutputTokens: number; modelTimeoutMs: number; commandTimeoutMs: number; runTimeoutMs: number;
  inputPrice: number | null; outputPrice: number | null;
}
const modelEnv: Record<Role, string> = {
  pm: 'PM_MODEL', 'tech-lead': 'TECH_LEAD_MODEL', 'developer-a': 'IMPLEMENTATION_DEV_MODEL',
  'developer-b': 'RELIABILITY_DEV_MODEL', qa: 'QA_MODEL', reviewer: 'REVIEWER_MODEL',
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FactoryConfig {
  const provider = env.FACTORY_PROVIDER || 'auto';
  if (!['auto', 'jigjoy', 'openai', 'anthropic', 'gemini'].includes(provider)) throw new Error('FACTORY_PROVIDER must be auto, jigjoy, openai, anthropic or gemini');
  const effort = env.FACTORY_REASONING_EFFORT || undefined;
  if (effort && !['low', 'medium', 'high', 'max'].includes(effort)) throw new Error('FACTORY_REASONING_EFFORT must be low, medium, high or max');
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
    return value;
  };
  const price = (name: string): number | null => {
    if (!env[name]) return null;
    const value = Number(env[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a nonnegative number`);
    return value;
  };
  return {
    provider: provider as FactoryConfig['provider'],
    ...(effort ? { reasoningEffort: effort as FactoryConfig['reasoningEffort'] } : {}),
    models: Object.fromEntries(Object.entries(modelEnv).map(([role, key]) => [role, env[key] || env.FACTORY_MODEL || (provider === 'jigjoy' ? 'deepseek-flash' : provider === 'gemini' ? 'gemini-3.5-flash-lite' : provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.4-mini')])) as Record<Role, string>,
    maxRetries: integer('MAX_RETRIES_PER_TICKET', 2, 0, 5),
    maxProviderRetries: integer('MAX_PROVIDER_RETRIES', 1, 0, 3),
    maxPlanningRetries: integer('MAX_PLANNING_RETRIES', 2, 0, 5),
    maxModelCalls: integer('MAX_MODEL_CALLS_PER_TURN', 30, 1, 100),
    maxOutputTokens: integer('MAX_OUTPUT_TOKENS', provider === 'jigjoy' ? 32768 : 12000, 128, 65536),
    modelTimeoutMs: integer('MODEL_TIMEOUT_MS', provider === 'jigjoy' ? 240000 : 120000, 50, 600000),
    commandTimeoutMs: integer('COMMAND_TIMEOUT_MS', 30000, 100, 300000),
    runTimeoutMs: integer('RUN_TIMEOUT_MS', 900000, 1000, 3600000),
    inputPrice: price('INPUT_USD_PER_MILLION'), outputPrice: price('OUTPUT_USD_PER_MILLION'),
  };
}
export function validateModels(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.provider === 'jigjoy') {
    for (const model of Object.values(config.models)) if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error('Invalid hosted model identifier');
    return; // Hosted aliases belong to the gateway, not the upstream registry.
  }
  for (const name of new Set(Object.values(config.models))) {
    const model = supportedModels.find(m => m.specification.name === name);
    if (!model) throw new Error(`Model ${name} is not in Mozaik 4.2.0's registry. Choose a supported model or inject an InferenceRunner.`);
    const provider = model.specification.provider.toLowerCase();
    if (config.provider !== 'auto' && !provider.includes(config.provider) && !(config.provider === 'gemini' && provider.includes('google'))) throw new Error(`Model ${name} does not belong to FACTORY_PROVIDER=${config.provider}`);
    const key = provider.includes('anthropic') ? 'ANTHROPIC_API_KEY' : provider.includes('gemini') || provider.includes('google') ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
    if (!env[key]) throw new Error(`${key} is required for ${name}. Copy .env.example to .env. Use --demo for the offline Sum CLI fixture.`);
  }
}
