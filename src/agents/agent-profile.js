import { readFileSync } from 'fs';
import matter from 'gray-matter';

export class AgentProfile {
  constructor({ name, description, model, tools, memoryNamespace, soul }) {
    this.name = name;
    this.description = description || '';
    this.model = model || null;
    this.tools = tools || null; // null means inherit from role
    this.memoryNamespace = memoryNamespace || null;
    this.soul = soul || '';
  }

  static fromFile(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const { data, content: body } = matter(content);

    return new AgentProfile({
      name: data.name,
      description: data.description,
      model: data.model,
      tools: data.tools,
      memoryNamespace: data.memory_namespace,
      soul: body.trim(),
    });
  }
}
