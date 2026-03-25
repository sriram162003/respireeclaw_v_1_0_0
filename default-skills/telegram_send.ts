// telegram_send skill — send Telegram messages to contacts or arbitrary chat IDs
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONTACTS_FILE = path.join(os.homedir(), '.aura', 'workspace', 'contacts.md');

/** Parse contacts.md table and return chat_id for a name (case-insensitive partial match) */
function lookupContact(name: string): string | null {
  if (!fs.existsSync(CONTACTS_FILE)) return null;
  const lines = fs.readFileSync(CONTACTS_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/\|\s*(.+?)\s*\|\s*(\d+)\s*\|/);
    if (match && match[1].toLowerCase().includes(name.toLowerCase())) {
      return match[2]!;
    }
  }
  return null;
}

async function tgCall(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telegram ${method} HTTP ${res.status}`);
  const data = await res.json() as { ok: boolean; description?: string; result?: unknown };
  if (!data.ok) throw new Error(`Telegram error: ${data.description ?? 'unknown'}`);
  return data.result;
}

export async function send_telegram_message(
  args: Record<string, unknown>,
  _ctx: unknown,
): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const to      = String(args['to'] ?? '').trim();
  const message = String(args['message'] ?? '').trim();
  if (!to)      throw new Error('to is required (contact name or numeric chat_id)');
  if (!message) throw new Error('message is required');

  // Resolve: numeric → use directly, otherwise look up contacts.md
  let chatId = to;
  let resolvedName: string | undefined;
  if (!/^\d+$/.test(to)) {
    const found = lookupContact(to);
    if (!found) throw new Error(`Contact "${to}" not found in contacts.md. Check the file or pass a numeric chat_id directly.`);
    chatId = found;
    resolvedName = to;
  }

  await tgCall(token, 'sendMessage', { chat_id: chatId, text: message });

  return {
    sent: true,
    to: resolvedName ?? chatId,
    chat_id: chatId,
    note: 'Message delivered via Telegram.',
  };
}

export async function list_contacts(
  _args: Record<string, unknown>,
  _ctx: unknown,
): Promise<unknown> {
  if (!fs.existsSync(CONTACTS_FILE)) return { contacts: [], note: 'contacts.md not found' };
  const content = fs.readFileSync(CONTACTS_FILE, 'utf8');
  const contacts: Array<{ name: string; chat_id: string }> = [];
  for (const line of content.split('\n')) {
    const match = line.match(/\|\s*(.+?)\s*\|\s*(\d+)\s*\|/);
    if (match) contacts.push({ name: match[1]!.trim(), chat_id: match[2]!.trim() });
  }
  return { contacts, source: CONTACTS_FILE };
}
