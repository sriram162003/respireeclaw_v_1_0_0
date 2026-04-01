import fs from 'fs';
import path from 'path';
import os from 'os';

const TODOS_DIR = path.join(os.homedir(), '.aura', 'workspace', 'todos');

export interface TodoItem {
  id:       string;
  content:  string;
  status:   'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

function todoPath(agentNs: string): string {
  // Sanitize namespace to safe filename
  return path.join(TODOS_DIR, `${agentNs.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

export function readTodos(agentNs: string): TodoItem[] {
  try {
    const p = todoPath(agentNs);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as TodoItem[];
  } catch {
    return [];
  }
}

export function writeTodos(agentNs: string, todos: TodoItem[]): void {
  fs.mkdirSync(TODOS_DIR, { recursive: true });
  fs.writeFileSync(todoPath(agentNs), JSON.stringify(todos, null, 2), 'utf8');
}

/**
 * Format todo list for system prompt injection.
 * Matches Claude Code's style: numbered list with [status] brackets,
 * priority annotation for high-priority items, all tasks shown.
 */
export function formatTodosForPrompt(todos: TodoItem[]): string {
  if (todos.length === 0) return '';
  return todos
    .map((t, i) => {
      const priority = t.priority === 'high' ? ' (high priority)' : '';
      return `${i + 1}. [${t.status}] ${t.content}${priority}`;
    })
    .join('\n');
}
