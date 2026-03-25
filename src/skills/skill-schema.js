import { z } from 'zod';

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().default('1.0.0'),
  trigger: z.string().optional(),
  tools: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
  always: z.boolean().default(false),
});

export function validateSkill(frontmatter) {
  const result = skillFrontmatterSchema.safeParse(frontmatter);
  return {
    valid: result.success,
    data: result.success ? result.data : undefined,
    errors: result.success ? [] : result.error.issues.map(i => i.message),
  };
}
