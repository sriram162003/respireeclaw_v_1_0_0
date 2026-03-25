// Wazuh 4.x SIEM Skill
// Env vars: WAZUH_URL, WAZUH_USER, WAZUH_PASS, WAZUH_VERIFY_TLS
//           WAZUH_INDEXER_URL, WAZUH_INDEXER_USER, WAZUH_INDEXER_PASS
//
// Tools:
//   wazuh_get_token       — authenticate with Wazuh 4.x JWT API
//   wazuh_fetch_alerts    — poll Wazuh REST API for recent alerts
//   wazuh_receive_alert   — process a single webhook-pushed alert payload
//   wazuh_analyze_alert   — deep-analyze a stored alert by alert_id
//   wazuh_get_alert_history — query stored alerts from SQLite

import Database from 'better-sqlite3';
import https from 'https';
import os from 'os';
import path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  const url       = (process.env['WAZUH_URL']        ?? 'https://host.docker.internal:55000').replace(/\/$/, '');
  const user      = process.env['WAZUH_USER']        ?? 'wazuh';
  const pass      = process.env['WAZUH_PASS']        ?? '';
  const verifyTls = (process.env['WAZUH_VERIFY_TLS'] ?? 'false') === 'true';
  return { url, user, pass, verifyTls };
}

function getIndexerConfig() {
  const url  = (process.env['WAZUH_INDEXER_URL']  ?? 'https://host.docker.internal:9200').replace(/\/$/, '');
  const user = process.env['WAZUH_INDEXER_USER']  ?? 'admin';
  const pass = process.env['WAZUH_INDEXER_PASS']  ?? process.env['WAZUH_PASS'] ?? '';
  return { url, user, pass };
}

// ── TLS-aware HTTP helper ─────────────────────────────────────────────────────
// Wazuh ships with a self-signed certificate by default.
// When verifyTls=false we use https.request with rejectUnauthorized=false
// instead of native fetch (which enforces certificate validity).

interface SimpleResponse {
  ok:     boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function wazuhFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  verifyTls: boolean
): Promise<SimpleResponse> {
  if (verifyTls) {
    return fetch(url, {
      method:  options.method,
      headers: options.headers,
      body:    options.body,
      signal:  AbortSignal.timeout(10_000),
    }) as Promise<SimpleResponse>;
  }

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions: https.RequestOptions = {
      hostname:           parsedUrl.hostname,
      port:               parsedUrl.port || 443,
      path:               parsedUrl.pathname + parsedUrl.search,
      method:             options.method ?? 'GET',
      headers:            options.headers ?? {},
      rejectUnauthorized: false,
      timeout:            10_000,
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok:     status >= 200 && status < 300,
          status,
          json:   async () => JSON.parse(body) as unknown,
          text:   async () => body,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Wazuh request timed out')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── JWT token cache (in-process, resets on container restart) ─────────────────

const _cache = { token: '', expiresAt: 0 };

// ── SQLite ────────────────────────────────────────────────────────────────────

const DB_PATH = path.join(os.homedir(), '.aura', 'memory', 'aura.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wazuh_alerts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id         TEXT    NOT NULL UNIQUE,
      timestamp        TEXT    NOT NULL,
      rule_id          TEXT,
      rule_description TEXT,
      rule_level       INTEGER,
      severity         TEXT    CHECK(severity IN ('low','medium','high','critical')),
      agent_name       TEXT,
      agent_ip         TEXT,
      location         TEXT,
      groups           TEXT,
      full_alert       TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

// ── Severity mapping ──────────────────────────────────────────────────────────

function mapSeverity(level: number): 'low' | 'medium' | 'high' | 'critical' {
  if (level <= 6)  return 'low';
  if (level <= 11) return 'medium';
  if (level <= 14) return 'high';
  return 'critical';
}

// ── Alert normaliser ──────────────────────────────────────────────────────────
// Handles both Wazuh custom-integration push format and REST API log format.

interface NormalisedAlert {
  alert_id:         string;
  timestamp:        string;
  rule_id:          string;
  rule_description: string;
  rule_level:       number;
  severity:         'low' | 'medium' | 'high' | 'critical';
  agent_name:       string;
  agent_ip:         string;
  location:         string;
  groups:           string[];
  full_alert:       Record<string, unknown>;
}

function normaliseAlert(raw: Record<string, unknown>): NormalisedAlert {
  const rule  = (raw['rule']  ?? {}) as Record<string, unknown>;
  const agent = (raw['agent'] ?? {}) as Record<string, unknown>;

  const rawLevel = rule['level'] ?? raw['level'] ?? 0;
  const level = typeof rawLevel === 'string'
    ? ({ debug: 2, info: 3, warning: 7, error: 10, critical: 10 }[rawLevel.toLowerCase()] ?? 3)
    : Number(rawLevel);

  const groups: string[] = [];
  const rawGroups = rule['groups'];
  if (Array.isArray(rawGroups)) groups.push(...rawGroups.map(String));
  else if (typeof rawGroups === 'string') groups.push(rawGroups);

  return {
    alert_id:         String(raw['id'] ?? raw['_id'] ?? `wazuh-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    timestamp:        String(raw['timestamp'] ?? new Date().toISOString()),
    rule_id:          String(rule['id']          ?? ''),
    rule_description: String(rule['description'] ?? raw['description'] ?? ''),
    rule_level:       level,
    severity:         mapSeverity(level),
    agent_name:       String(agent['name'] ?? raw['hostname'] ?? 'unknown'),
    agent_ip:         String(agent['ip']   ?? ''),
    location:         String(raw['location'] ?? ''),
    groups,
    full_alert:       raw,
  };
}

function persistAlert(alert: NormalisedAlert): 'inserted' | 'duplicate' {
  const db = getDb();
  try {
    const info = db.prepare(`
      INSERT OR IGNORE INTO wazuh_alerts
        (alert_id, timestamp, rule_id, rule_description, rule_level,
         severity, agent_name, agent_ip, location, groups, full_alert)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      alert.alert_id,
      alert.timestamp,
      alert.rule_id,
      alert.rule_description,
      alert.rule_level,
      alert.severity,
      alert.agent_name,
      alert.agent_ip,
      alert.location,
      JSON.stringify(alert.groups),
      JSON.stringify(alert.full_alert),
    );
    return info.changes > 0 ? 'inserted' : 'duplicate';
  } finally {
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 1 — wazuh_get_token
// ═══════════════════════════════════════════════════════════════════════════════

export async function wazuh_get_token(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  // Return cached token if it has more than 5 minutes remaining
  if (_cache.token && Date.now() < _cache.expiresAt - 300_000) {
    return { token: _cache.token, cached: true };
  }

  const { url, user, pass, verifyTls } = getConfig();
  if (!pass) throw new Error('WAZUH_PASS environment variable is not set');

  const basicAuth = Buffer.from(`${user}:${pass}`).toString('base64');
  const res = await wazuhFetch(
    `${url}/security/user/authenticate`,
    {
      method:  'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/json' },
    },
    verifyTls
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wazuh authentication failed (${res.status}): ${body}`);
  }

  const json  = await res.json() as Record<string, unknown>;
  const token = ((json['data'] as Record<string, unknown>)?.['token']) as string | undefined;
  if (!token) throw new Error('JWT token not found in Wazuh auth response');

  _cache.token     = token;
  _cache.expiresAt = Date.now() + 900_000; // Wazuh default token TTL: 900s

  return { token, cached: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2 — wazuh_fetch_alerts
// ═══════════════════════════════════════════════════════════════════════════════

export async function wazuh_fetch_alerts(
  args: { limit?: number; min_level?: number; since_hours?: number },
  _ctx: unknown
): Promise<unknown> {
  const limit     = Math.min(args.limit ?? 50, 500);
  const min_level = args.min_level ?? 1;
  const since_hours = args.since_hours ?? 24;

  const { url, user, pass } = getIndexerConfig();
  const basicAuth = Buffer.from(`${user}:${pass}`).toString('base64');

  // Query OpenSearch wazuh-alerts-* index — real fired security alerts
  const query = {
    size: limit,
    sort: [{ '@timestamp': { order: 'desc' } }],
    query: {
      bool: {
        must: [
          { range: { 'rule.level': { gte: min_level } } },
          { range: { '@timestamp': { gte: `now-${Math.floor(since_hours)}h` } } },
        ],
      },
    },
    _source: ['@timestamp', 'agent', 'rule', 'location', 'decoder', 'data', 'manager', 'id'],
  };

  const res = await wazuhFetch(
    `${url}/wazuh-alerts-4.x-*/_search`,
    {
      method:  'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(query),
    },
    false // indexer always uses self-signed cert
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`wazuh_fetch_alerts (indexer) failed (${res.status}): ${body}`);
  }

  const json = await res.json() as Record<string, unknown>;
  const hits = ((json['hits'] as Record<string, unknown>)?.['hits'] ?? []) as Record<string, unknown>[];

  let stored = 0;
  const results: ReturnType<typeof normaliseAlert>[] = [];

  for (const hit of hits) {
    try {
      const src = (hit['_source'] ?? {}) as Record<string, unknown>;
      // Merge OpenSearch _id as alert id
      src['id'] = src['id'] ?? hit['_id'];
      src['timestamp'] = src['@timestamp'] ?? src['timestamp'];
      const normalised = normaliseAlert(src);
      if (persistAlert(normalised) === 'inserted') stored++;
      results.push(normalised);
    } catch {
      // skip malformed entries
    }
  }

  return {
    fetched: results.length,
    stored,
    alerts: results.map(a => ({
      alert_id:         a.alert_id,
      timestamp:        a.timestamp,
      rule_id:          a.rule_id,
      rule_description: a.rule_description,
      rule_level:       a.rule_level,
      severity:         a.severity,
      agent_name:       a.agent_name,
      location:         a.location,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 3 — wazuh_receive_alert
// ═══════════════════════════════════════════════════════════════════════════════

export async function wazuh_receive_alert(
  args: { payload: Record<string, unknown> },
  _ctx: unknown
): Promise<unknown> {
  if (!args.payload || typeof args.payload !== 'object') {
    return { status: 'error', message: 'payload must be a JSON object' };
  }

  const alert  = normaliseAlert(args.payload);
  const result = persistAlert(alert);

  const recommended_action =
    alert.severity === 'critical' ? 'Immediate investigation required' :
    alert.severity === 'high'     ? 'Investigate within 1 hour' :
    alert.severity === 'medium'   ? 'Review within 24 hours' :
                                    'Log and monitor';

  return {
    status:           result === 'inserted' ? 'stored' : 'duplicate',
    alert_id:         alert.alert_id,
    timestamp:        alert.timestamp,
    rule_id:          alert.rule_id,
    rule_description: alert.rule_description,
    rule_level:       alert.rule_level,
    severity:         alert.severity,
    agent_name:       alert.agent_name,
    agent_ip:         alert.agent_ip,
    location:         alert.location,
    groups:           alert.groups,
    triage: {
      severity_label:      alert.severity,
      recommended_action,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 4 — wazuh_analyze_alert
// ═══════════════════════════════════════════════════════════════════════════════

export async function wazuh_analyze_alert(
  args: { alert_id: string },
  _ctx: unknown
): Promise<unknown> {
  if (!args.alert_id) throw new Error('alert_id is required');

  const db  = getDb();
  const row = db.prepare('SELECT * FROM wazuh_alerts WHERE alert_id = ?')
                .get(args.alert_id) as Record<string, unknown> | undefined;
  db.close();

  if (!row) return { status: 'not_found', alert_id: args.alert_id };

  const level     = Number(row['rule_level']);
  const severity  = String(row['severity']);
  const groups    = JSON.parse(String(row['groups']    ?? '[]')) as string[];
  const fullAlert = JSON.parse(String(row['full_alert'] ?? '{}')) as Record<string, unknown>;

  const isThreatRule    = groups.some(g => ['attack','intrusion','exploit','malware','virus','trojan','injection','brute_force'].includes(g.toLowerCase()));
  const isAuthRule      = groups.some(g => ['authentication','ssh','login','pam','sudo','su'].includes(g.toLowerCase()));
  const isIntegrityRule = groups.some(g => ['syscheck','rootcheck','fim'].includes(g.toLowerCase()));
  const isNetRule       = groups.some(g => ['firewall','network','iptables','scan'].includes(g.toLowerCase()));

  const category =
    isThreatRule    ? 'threat_detection'  :
    isAuthRule      ? 'authentication'    :
    isIntegrityRule ? 'file_integrity'    :
    isNetRule       ? 'network_activity'  :
    level >= 12     ? 'high_severity_event' :
                      'informational';

  const recommended_actions: string[] = [];
  if (severity === 'critical') {
    recommended_actions.push('Isolate affected agent immediately');
    recommended_actions.push('Take forensic snapshot of the instance');
    recommended_actions.push('Escalate to security team');
    recommended_actions.push('Review /var/ossec/logs/alerts/alerts.log on the Wazuh manager');
  } else if (severity === 'high') {
    recommended_actions.push('Investigate agent for lateral movement indicators');
    recommended_actions.push('Review authentication logs on the affected host');
    recommended_actions.push('Cross-reference with other alerts from the same agent in the last hour');
  } else if (severity === 'medium') {
    recommended_actions.push('Correlate with other recent alerts from the same agent');
    recommended_actions.push('Review relevant application/service logs');
  } else {
    recommended_actions.push('Add to watchlist for pattern analysis');
  }

  if (isIntegrityRule)  recommended_actions.push('Run wazuh_fetch_alerts to retrieve related FIM events');
  if (isAuthRule)       recommended_actions.push('Check for repeated auth failures from the same source IP');
  if (isThreatRule)     recommended_actions.push('Verify with threat intelligence feeds');

  return {
    alert_id: args.alert_id,
    analysis: {
      severity,
      category,
      rule_level:       level,
      rule_id:          String(row['rule_id']),
      rule_description: String(row['rule_description']),
      agent_name:       String(row['agent_name']),
      agent_ip:         String(row['agent_ip']),
      location:         String(row['location']),
      groups,
      timestamp:        String(row['timestamp']),
    },
    threat_indicators: {
      is_threat_rule:    isThreatRule,
      is_auth_rule:      isAuthRule,
      is_integrity_rule: isIntegrityRule,
      is_network_rule:   isNetRule,
      category,
    },
    recommended_actions,
    // Ready-made sentence for the agent LLM to incorporate into its response
    llm_prompt_hint: `This is a ${severity.toUpperCase()} severity ${category} alert from agent "${row['agent_name']}" (${row['agent_ip']}). Rule: "${row['rule_description']}" (level ${level}). Recommended actions: ${recommended_actions.join('; ')}.`,
    raw_alert: fullAlert,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 5 — wazuh_get_alert_history
// ═══════════════════════════════════════════════════════════════════════════════

export async function wazuh_get_alert_history(
  args: { severity?: string; since_hours?: number; limit?: number; agent_name?: string },
  _ctx: unknown
): Promise<unknown> {
  const limit = args.limit ?? 50;
  const conditions: string[] = [];
  const params:     unknown[] = [];

  if (args.severity) {
    conditions.push('severity = ?');
    params.push(args.severity);
  }
  if (args.since_hours) {
    conditions.push(`created_at >= datetime('now', '-${Math.floor(args.since_hours)} hours')`);
  }
  if (args.agent_name) {
    conditions.push('agent_name LIKE ?');
    params.push(`%${args.agent_name}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const db   = getDb();
  const rows = db.prepare(`
    SELECT id, alert_id, timestamp, rule_id, rule_description, rule_level,
           severity, agent_name, agent_ip, location, groups, created_at
    FROM wazuh_alerts ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params) as Record<string, unknown>[];
  db.close();

  const bySeverity: Record<string, number> = {};
  for (const row of rows) {
    const s = String(row['severity']);
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
  }

  return {
    total: rows.length,
    filters: { severity: args.severity, since_hours: args.since_hours, agent_name: args.agent_name, limit },
    summary: bySeverity,
    alerts: rows.map(r => ({
      id:               r['id'],
      alert_id:         r['alert_id'],
      timestamp:        r['timestamp'],
      rule_id:          r['rule_id'],
      rule_description: r['rule_description'],
      rule_level:       r['rule_level'],
      severity:         r['severity'],
      agent_name:       r['agent_name'],
      agent_ip:         r['agent_ip'],
      location:         r['location'],
      groups:           JSON.parse(String(r['groups'] ?? '[]')),
      created_at:       r['created_at'],
    })),
  };
}
