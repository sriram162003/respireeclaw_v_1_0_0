import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

export interface ApiKey {
  name: string;
  key: string;
  created: string;
  last_used?: string;
}

const KEYS_FILE = path.join(os.homedir(), '.aura', 'keys.yaml');

export function loadKeysFile(): { keys: ApiKey[] } {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      return yaml.load(fs.readFileSync(KEYS_FILE, 'utf8')) as { keys: ApiKey[] };
    }
  } catch { /* ignore */ }
  return { keys: [] };
}

function saveKeysFile(data: { keys: ApiKey[] }): void {
  fs.writeFileSync(KEYS_FILE, yaml.dump(data, { lineWidth: 120 }), 'utf8');
}

export function generateApiKey(): string {
  return `sk-aura-${crypto.randomBytes(16).toString('hex')}`;
}

export function listApiKeys(): ApiKey[] {
  return loadKeysFile().keys;
}

export function addApiKey(name: string): ApiKey {
  const data = loadKeysFile();
  const newKey: ApiKey = {
    name,
    key: generateApiKey(),
    created: new Date().toISOString(),
  };
  data.keys.push(newKey);
  saveKeysFile(data);
  return newKey;
}

export function revokeApiKey(name: string): boolean {
  const data = loadKeysFile();
  const idx = data.keys.findIndex(k => k.name === name);
  if (idx === -1) return false;
  data.keys.splice(idx, 1);
  saveKeysFile(data);
  return true;
}

export function validateApiKey(inputKey: string): ApiKey | null {
  const data = loadKeysFile();
  const found = data.keys.find(k => k.key === inputKey);
  if (found) {
    found.last_used = new Date().toISOString();
    saveKeysFile(data);
    return found;
  }
  return null;
}

export function getMasterKey(): string | null {
  return process.env.AURA_API_KEY ?? null;
}

export function authenticateRequest(authHeader: string | undefined): { authorized: boolean; key?: ApiKey; error?: string } {
  if (!authHeader) {
    return { authorized: false, error: 'Missing Authorization header' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return { authorized: false, error: 'Invalid Authorization format. Use: Bearer <api-key>' };
  }

  const token = parts[1];

  const validated = validateApiKey(token);
  if (validated) {
    return { authorized: true, key: validated };
  }

  const masterKey = getMasterKey();
  if (masterKey && token === masterKey) {
    return { authorized: true, key: { name: 'master', key: token, created: 'master' } };
  }

  return { authorized: false, error: 'Invalid API key' };
}

export function initDefaultKey(): void {
  const data = loadKeysFile();
  if (data.keys.length === 0) {
    const defaultKey = addApiKey('default');
    console.log(`[Auth] Generated default API key: ${defaultKey.key}`);
    console.log(`[Auth] Key saved to: ${KEYS_FILE}`);
  }
}
