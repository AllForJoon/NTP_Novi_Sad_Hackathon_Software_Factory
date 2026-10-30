import type { z } from 'zod';
import { jsonSchema } from '../schemas.js';

type JsonSchema = Record<string, unknown> | boolean;
export type SchemaProfile = 'json-schema' | 'gemini-legacy';

// Generation guidance only. Never use this projection to validate returned data.
const allowedKeywords = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'title', 'description',
  'properties', 'required', 'additionalProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'enum', 'minimum', 'maximum', 'anyOf', 'oneOf', 'format',
]);
// Mozaik 4.2.0 sends structured output through responseSchema, not
// responseJsonSchema. That legacy surface does not accept JSON-Schema-only keys.
const legacyKeywords = new Set([
  'type', 'title', 'description', 'properties', 'required', 'items',
  'minItems', 'maxItems', 'enum', 'minimum', 'maximum', 'anyOf', 'format',
]);
const schemaMaps = new Set(['properties', '$defs']);
const schemaLists = new Set(['prefixItems', 'anyOf', 'oneOf']);
const schemaValues = new Set(['items', 'additionalProperties']);

export function sanitizeInferenceSchema(schema: JsonSchema, profile: SchemaProfile = 'json-schema'): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  const allowed = profile === 'gemini-legacy' ? legacyKeywords : allowedKeywords;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => allowed.has(key)).map(([key, value]) => {
    if (schemaMaps.has(key))
      return [key, Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [name, sanitizeInferenceSchema(child, profile)]))];
    if (schemaLists.has(key)) return [key, (value as JsonSchema[]).map(child => sanitizeInferenceSchema(child, profile))];
    if (schemaValues.has(key)) return [key, sanitizeInferenceSchema(value as JsonSchema, profile)];
    // enum/required/type arrays and descriptions contain literal DATA, not schema
    // nodes. Clone them unchanged, even when they contain keyword-like names.
    return [key, structuredClone(value)];
  }));
}

export function inferenceJsonSchema(schema: z.ZodType, model?: string): Record<string, unknown> {
  const profile = model?.startsWith('gemini-') ? 'gemini-legacy' : 'json-schema';
  return sanitizeInferenceSchema(jsonSchema(schema), profile) as Record<string, unknown>;
}
