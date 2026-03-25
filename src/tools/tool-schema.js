import { z } from 'zod';

/**
 * Convert a JSON Schema object to a Zod schema for runtime validation.
 * Supports: string, number, integer, boolean, object, array.
 */
export function jsonSchemaToZod(schema) {
  if (!schema || !schema.type) return z.any();

  switch (schema.type) {
    case 'string': {
      let s = z.string();
      if (schema.minLength) s = s.min(schema.minLength);
      if (schema.maxLength) s = s.max(schema.maxLength);
      if (schema.enum) s = z.enum(schema.enum);
      return schema.description ? s.describe(schema.description) : s;
    }
    case 'number':
    case 'integer': {
      let n = schema.type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return schema.description ? n.describe(schema.description) : n;
    }
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = schema.items ? jsonSchemaToZod(schema.items) : z.any();
      return z.array(items);
    }
    case 'object': {
      if (!schema.properties) return z.object({}).passthrough();
      const shape = {};
      const required = new Set(schema.required || []);
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const zodProp = jsonSchemaToZod(propSchema);
        shape[key] = required.has(key) ? zodProp : zodProp.optional();
      }
      return z.object(shape);
    }
    default:
      return z.any();
  }
}

/**
 * Validate tool input against its JSON Schema definition.
 */
export function validateInput(input, schema) {
  try {
    const zodSchema = jsonSchemaToZod(schema);
    const result = zodSchema.safeParse(input);
    return {
      valid: result.success,
      data: result.success ? result.data : undefined,
      errors: result.success ? [] : result.error.issues.map(i => i.message),
    };
  } catch (err) {
    return { valid: false, data: undefined, errors: [err.message] };
  }
}
