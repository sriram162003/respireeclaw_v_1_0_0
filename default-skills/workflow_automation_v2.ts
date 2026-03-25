// workflow_automation_v2.ts
// General-purpose workflow automation engine for AURA Gateway
//
// Features:
//   - Named workflows stored as YAML in ~/.aura/workflows/
//   - Webhook triggers: match incoming key → auto-run matching workflows
//   - Conditional branching: if/else on any payload or step output field
//   - Multi-step chaining via on_success / on_failure / on_true / on_false
//   - Retry logic per step (max_attempts + exponential back-off)
//   - Step types: webhook, condition, wait, skill, transform, log, parallel
//   - parallel: runs any mix of sub-steps concurrently (Promise.allSettled)
//   - Template interpolation: {{payload.field}}, {{steps.id.output.field}}
//   - SQLite-backed execution history (wf_executions, wf_scheduled)
//   - Live dashboard updates pushed to /dashboard3/api/workflow-update

import Database from 'better-sqlite3';
import fs       from 'fs';
import path     from 'path';
import os       from 'os';
import yaml     from 'js-yaml';

// ── Constants ─────────────────────────────────────────────────────────────────
const AURA_DIR      = path.join(os.homedir(), '.aura');
const WORKFLOWS_DIR = path.join(AURA_DIR, 'workflows');
const DB_PATH       = path.join(AURA_DIR, 'memory', 'aura.db');

// ── SQLite init ───────────────────────────────────────────────────────────────
function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH);
  d.exec(`
    CREATE TABLE IF NOT EXISTS wf_executions (
      id            TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      trigger_type  TEXT DEFAULT 'manual',
      payload       TEXT DEFAULT '{}',
      steps_done    TEXT DEFAULT '[]',
      result        TEXT,
      error         TEXT,
      started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at  DATETIME
    );
    CREATE TABLE IF NOT EXISTS wf_scheduled (
      workflow_name TEXT PRIMARY KEY,
      cron          TEXT NOT NULL,
      enabled       INTEGER DEFAULT 1,
      last_run      DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return d;
}

// ── Live dashboard notify (fire-and-forget) ───────────────────────────────────
function notifyDashboard(execId: string, workflowName: string, status: string, data: Record<string, unknown>): void {
  fetch('http://localhost:3002/dashboard3/api/workflow-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ execution_id: execId, workflow_name: workflowName, status, data, timestamp: new Date().toISOString() }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* non-critical — dashboard may not be open */ });
}

// ── Template engine ───────────────────────────────────────────────────────────
// Replaces {{path.to.value}} via dot-path traversal into the execution context.
// Available in all string fields of any step:
//   {{payload.field}}          — trigger input
//   {{steps.stepId.output.x}} — output of a previous step
//   {{env.execution_id}}       — execution metadata
function tpl(str: string, ctx: Record<string, unknown>): string {
  return str.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    let v: unknown = ctx;
    for (const k of expr.trim().split('.')) v = (v as Record<string, unknown>)?.[k];
    return v !== undefined && v !== null ? String(v) : `{{${expr}}}`;
  });
}

function tplDeep(obj: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof obj === 'string') return tpl(obj, ctx);
  if (Array.isArray(obj))     return obj.map(v => tplDeep(v, ctx));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = tplDeep(v, ctx);
    return out;
  }
  return obj;
}

// ── Condition evaluator ───────────────────────────────────────────────────────
// field: dot-path into ctx (e.g. "payload.cpu", "steps.check.output.status")
// operators: gt, lt, gte, lte, eq, ne, contains, exists, not_exists
function evalCond(cond: { field: string; operator: string; value?: unknown }, ctx: Record<string, unknown>): boolean {
  let actual: unknown = ctx;
  for (const k of cond.field.split('.')) actual = (actual as Record<string, unknown>)?.[k];
  const t = cond.value;
  switch (cond.operator) {
    case 'gt':         return Number(actual) > Number(t);
    case 'lt':         return Number(actual) < Number(t);
    case 'gte':        return Number(actual) >= Number(t);
    case 'lte':        return Number(actual) <= Number(t);
    case 'eq':         return String(actual) === String(t);
    case 'ne':         return String(actual) !== String(t);
    case 'contains':   return String(actual).includes(String(t));
    case 'exists':     return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    default:           return false;
  }
}

// ── Single step runner (no retry) ────────────────────────────────────────────
async function runStep(
  step: Record<string, unknown>,
  ctx: Record<string, unknown>,
  skillCtx: unknown
): Promise<{ out: unknown; next: string | null }> {
  const type = step['type'] as string;

  // ── condition ──────────────────────────────────────────────────────────────
  if (type === 'condition') {
    const cond   = step['condition'] as { field: string; operator: string; value?: unknown };
    const passed = evalCond(cond, ctx);
    return {
      out:  { result: passed, branch: passed ? 'true' : 'false' },
      next: passed ? ((step['on_true'] as string) ?? null) : ((step['on_false'] as string) ?? null),
    };
  }

  // ── webhook ────────────────────────────────────────────────────────────────
  if (type === 'webhook') {
    const url    = tpl(step['url'] as string, ctx);
    const method = ((step['method'] as string) ?? 'POST').toUpperCase();
    const hdrs   = tplDeep(step['headers'] ?? {}, ctx) as Record<string, string>;
    const bodyRaw = ['GET', 'HEAD'].includes(method)
      ? undefined
      : JSON.stringify(tplDeep(step['payload'] ?? {}, ctx));
    const res = await fetch(url, {
      method, body: bodyRaw,
      headers: { 'Content-Type': 'application/json', ...hdrs },
      signal: AbortSignal.timeout((step['timeout_ms'] as number) ?? 15_000),
    });
    const text = await res.text();
    if (!res.ok && !step['allow_failure'])
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as string */ }
    return { out: { status: res.status, body: parsed }, next: (step['on_success'] as string) ?? null };
  }

  // ── wait ───────────────────────────────────────────────────────────────────
  if (type === 'wait') {
    const ms = Number(tpl(String(step['duration_ms'] ?? 1000), ctx));
    await new Promise(r => setTimeout(r, Math.min(ms, 300_000))); // cap at 5 min
    return { out: { waited_ms: ms }, next: (step['on_success'] as string) ?? null };
  }

  // ── skill ──────────────────────────────────────────────────────────────────
  // Calls another skill's tool via the gateway REST endpoint.
  // Requires gateway to expose POST /api/skills/:skill/tools/:tool (added in rest.ts).
  if (type === 'skill') {
    const skillName = tpl(step['skill_name'] as string, ctx);
    const toolName  = tpl(step['tool_name'] as string, ctx);
    const params    = tplDeep(step['params'] ?? {}, ctx);
    const res = await fetch(`http://localhost:3002/api/skills/${skillName}/tools/${toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout((step['timeout_ms'] as number) ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok && !step['allow_failure'])
      throw new Error(`Skill ${skillName}/${toolName} failed (${res.status}): ${text.slice(0, 200)}`);
    let out: unknown = text;
    try { out = JSON.parse(text); } catch { /* keep */ }
    return { out, next: (step['on_success'] as string) ?? null };
  }

  // ── transform ──────────────────────────────────────────────────────────────
  // Extracts / reshapes data from context into named output fields.
  // mappings: { outputKey: "{{steps.prev.output.field}}" }
  if (type === 'transform') {
    const mappings = (step['mappings'] as Record<string, unknown>) ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(mappings)) out[k] = tplDeep(expr, ctx);
    return { out, next: (step['on_success'] as string) ?? null };
  }

  // ── log ────────────────────────────────────────────────────────────────────
  if (type === 'log') {
    const msg = tpl((step['message'] as string) ?? '', ctx);
    console.log(`[workflow:log] ${msg}`);
    return { out: { message: msg }, next: (step['on_success'] as string) ?? null };
  }

  // ── parallel ───────────────────────────────────────────────────────────────
  // Runs all sub-steps concurrently via Promise.allSettled.
  // Each sub-step is a full step definition (any type) with its own id.
  // Output keyed by sub-step id: { results: { subId: { status, output|error } }, all_succeeded, succeeded, failed }
  // Routes to on_success if all passed (or allow_failure=true), else on_failure.
  // Sub-step outputs are accessible in later steps via {{steps.parentId.output.results.subId.output.field}}
  if (type === 'parallel') {
    const subSteps = (step['steps'] as Record<string, unknown>[]) ?? [];
    if (!subSteps.length) throw new Error('parallel step requires at least one entry in steps[]');

    const settled = await Promise.allSettled(
      subSteps.map(sub =>
        execStep(sub, ctx, skillCtx).then(r => ({ id: (sub['id'] as string) ?? 'unnamed', out: r.out }))
      )
    );

    const results: Record<string, unknown> = {};
    let failCount = 0;
    for (let i = 0; i < settled.length; i++) {
      const s   = settled[i]!;
      const id  = (subSteps[i]!['id'] as string) ?? `step_${i}`;
      if (s.status === 'fulfilled') {
        results[id] = { status: 'fulfilled', output: s.value.out };
      } else {
        results[id] = { status: 'rejected', error: String(s.reason) };
        failCount++;
      }
    }

    const out = { results, all_succeeded: failCount === 0, succeeded: settled.length - failCount, failed: failCount };
    if (failCount > 0 && !step['allow_failure']) {
      return { out, next: (step['on_failure'] as string) ?? null };
    }
    return { out, next: (step['on_success'] as string) ?? null };
  }

  // ── llm ────────────────────────────────────────────────────────────────────
  if (type === 'llm') {
    const sc = skillCtx as { llm?: { complete: (tier: string, prompt: string, system?: string) => Promise<{ text: string }> } } | undefined;
    if (!sc?.llm) throw new Error('llm step requires LLM context — not available in this execution environment');
    const prompt = tpl(step['prompt'] as string, ctx);
    const system = step['system'] ? tpl(step['system'] as string, ctx) : undefined;
    const tier   = (step['tier'] as string) ?? 'simple';
    const result = await sc.llm.complete(tier, prompt, system);
    return { out: { text: result.text }, next: (step['on_success'] as string) ?? null };
  }

  throw new Error(`Unknown step type: "${type}". Valid types: webhook, condition, wait, skill, transform, log, parallel, llm`);
}

// ── Step executor with retry ──────────────────────────────────────────────────
async function execStep(
  step: Record<string, unknown>,
  ctx: Record<string, unknown>,
  skillCtx: unknown
): Promise<{ out: unknown; next: string | null }> {
  const retry     = step['retry'] as { max_attempts?: number; delay_ms?: number } | undefined;
  const maxTries  = retry?.max_attempts ?? 1;
  const baseDelay = retry?.delay_ms ?? 1000;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await runStep(step, ctx, skillCtx);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxTries) await new Promise(r => setTimeout(r, baseDelay * attempt));
    }
  }

  const onFail = step['on_failure'] as string | undefined;
  if (onFail) return { out: { error: lastErr!.message, attempts: maxTries }, next: onFail };
  throw lastErr!;
}

// ── Workflow definition loader ────────────────────────────────────────────────
function loadDef(name: string): Record<string, unknown> {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  for (const ext of ['yaml', 'json']) {
    const fp = path.join(WORKFLOWS_DIR, `${name}.${ext}`);
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8');
      return (ext === 'json' ? JSON.parse(raw) : yaml.load(raw)) as Record<string, unknown>;
    }
  }
  throw new Error(`Workflow not found: "${name}". Save it first with workflow_save.`);
}

// ── Main execution engine ─────────────────────────────────────────────────────
async function execute(
  def:         Record<string, unknown>,
  payload:     unknown,
  execId:      string,
  triggerType: string,
  skillCtx:    unknown = undefined
): Promise<Record<string, unknown>> {
  // Build execution context
  const ctx: Record<string, unknown> = {
    payload,
    steps: {} as Record<string, unknown>,
    env: {
      execution_id: execId,
      workflow:     def['name'],
      trigger:      triggerType,
      started_at:   new Date().toISOString(),
    },
  };

  const steps   = (def['steps'] as Record<string, unknown>[]) ?? [];
  const stepMap = Object.fromEntries(steps.map(s => [(s['id'] as string), s]));
  let cur: string | null = (steps[0]?.['id'] as string) ?? null;
  const done: string[] = [];

  // Mark running in DB
  { const d = openDb(); d.prepare(`UPDATE wf_executions SET status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(execId); d.close(); }
  notifyDashboard(execId, def['name'] as string, 'running', { step: cur, step_index: 0, total_steps: steps.length });

  try {
    while (cur) {
      // Cycle guard
      if (done.filter(x => x === cur).length > 10)
        throw new Error(`Execution cycle detected at step: "${cur}"`);
      // Terminal step ID (e.g. "end", "done", "finish") — stop gracefully
      if (!stepMap[cur]) break;

      done.push(cur);
      const step = stepMap[cur]!;
      const { out, next } = await execStep(step, ctx, skillCtx);
      (ctx['steps'] as Record<string, unknown>)[cur] = {
        output: out, status: 'done', at: new Date().toISOString(),
      };
      cur = next;

      // Checkpoint
      { const d = openDb(); d.prepare(`UPDATE wf_executions SET steps_done=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(done), execId); d.close(); }
      notifyDashboard(execId, def['name'] as string, 'running', { step: cur ?? 'done', step_index: done.length, total_steps: steps.length });
    }

    // Success
    const result = JSON.stringify(ctx['steps']);
    { const d = openDb(); d.prepare(`UPDATE wf_executions SET status='completed', result=?, steps_done=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(result, JSON.stringify(done), execId); d.close(); }
    notifyDashboard(execId, def['name'] as string, 'completed', { steps_executed: done.length, total_steps: steps.length });

    return { execution_id: execId, workflow: def['name'] as string, status: 'completed', steps_executed: done, result: ctx['steps'] };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    { const d = openDb(); d.prepare(`UPDATE wf_executions SET status='failed', error=?, steps_done=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(msg, JSON.stringify(done), execId); d.close(); }
    notifyDashboard(execId, def['name'] as string, 'failed', { error: msg, steps_executed: done.length });

    return { execution_id: execId, workflow: def['name'] as string, status: 'failed', steps_executed: done, error: msg };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool exports
// ══════════════════════════════════════════════════════════════════════════════

/** Run a named workflow with an optional input payload. */
export async function workflow_run(
  args: { name: string; payload?: unknown; async?: boolean },
  _ctx: unknown
): Promise<unknown> {
  const def    = loadDef(args.name);
  const execId = `exec-${args.name.replace(/\W+/g, '-')}-${Date.now()}`;
  { const d = openDb(); d.prepare(`INSERT INTO wf_executions (id, workflow_name, trigger_type, payload) VALUES (?, ?, 'manual', ?)`).run(execId, args.name, JSON.stringify(args.payload ?? {})); d.close(); }

  if (args.async) {
    execute(def, args.payload ?? {}, execId, 'manual', _ctx).catch(e => console.error('[workflow] async error:', e));
    return { execution_id: execId, status: 'started', async: true };
  }
  return execute(def, args.payload ?? {}, execId, 'manual', _ctx);
}

/** Save or update a workflow definition to ~/.aura/workflows/<name>.yaml */
export async function workflow_save(
  args: { name: string; definition: unknown },
  _ctx: unknown
): Promise<unknown> {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const fp  = path.join(WORKFLOWS_DIR, `${args.name}.yaml`);
  const out = typeof args.definition === 'string'
    ? args.definition
    : yaml.dump(args.definition, { lineWidth: 120 });
  fs.writeFileSync(fp, out, 'utf8');
  return { saved: true, name: args.name, path: fp };
}

/** List all saved workflow definitions and recent execution history. */
export async function workflow_list(_args: unknown, _ctx: unknown): Promise<unknown> {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => /\.(yaml|json)$/.test(f));
  const definitions = files.map(f => {
    const name = f.replace(/\.(yaml|json)$/, '');
    try {
      const def     = loadDef(name);
      const trigger = def['trigger'] as Record<string, unknown> | undefined;
      return {
        name,
        description: (def['description'] as string) ?? '',
        steps:       ((def['steps'] as unknown[]) ?? []).length,
        trigger:     trigger?.['type'] ?? 'manual',
        schedule:    trigger?.['schedule'] ?? null,
        webhook_key: trigger?.['webhook_key'] ?? null,
      };
    } catch { return { name, error: 'parse error' }; }
  });

  const d      = openDb();
  const recent = d.prepare(`SELECT id, workflow_name, status, trigger_type, started_at, completed_at, error FROM wf_executions ORDER BY started_at DESC LIMIT 50`).all();
  d.close();
  return { definitions, recent_executions: recent };
}

/** Delete a saved workflow definition by name. */
export async function workflow_delete(args: { name: string }, _ctx: unknown): Promise<unknown> {
  let deleted = false;
  for (const ext of ['yaml', 'json']) {
    const fp = path.join(WORKFLOWS_DIR, `${args.name}.${ext}`);
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted = true; }
  }
  if (!deleted) throw new Error(`Workflow not found: "${args.name}"`);
  return { deleted: true, name: args.name };
}

/** Process an incoming webhook and fire all workflows matching the webhook_key. */
export async function workflow_trigger_webhook(
  args: { webhook_key: string; payload: unknown },
  _ctx: unknown
): Promise<unknown> {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const results: Array<{ workflow: string; execution_id: string }> = [];

  for (const f of fs.readdirSync(WORKFLOWS_DIR).filter(f => /\.(yaml|json)$/.test(f))) {
    const name = f.replace(/\.(yaml|json)$/, '');
    try {
      const def     = loadDef(name);
      const trigger = def['trigger'] as Record<string, unknown> | undefined;
      if (trigger?.['type'] === 'webhook' && trigger?.['webhook_key'] === args.webhook_key) {
        const execId = `exec-${name}-${Date.now()}`;
        { const d = openDb(); d.prepare(`INSERT INTO wf_executions (id, workflow_name, trigger_type, payload) VALUES (?, ?, 'webhook', ?)`).run(execId, name, JSON.stringify(args.payload)); d.close(); }
        execute(def, args.payload, execId, 'webhook', undefined).catch(e => console.error('[workflow] webhook error:', e));
        results.push({ workflow: name, execution_id: execId });
      }
    } catch { /* skip unparseable workflows */ }
  }

  return { triggered: results.length, executions: results, webhook_key: args.webhook_key };
}

/** Get execution status by ID, or list recent executions for a workflow. */
export async function workflow_status(
  args: { execution_id?: string; workflow_name?: string; limit?: number },
  _ctx: unknown
): Promise<unknown> {
  const d = openDb();
  if (args.execution_id) {
    const row = d.prepare(`SELECT * FROM wf_executions WHERE id=?`).get(args.execution_id) as Record<string, unknown> | undefined;
    d.close();
    if (!row) throw new Error(`Execution not found: ${args.execution_id}`);
    return {
      ...row,
      result:     row['result']     ? JSON.parse(row['result'] as string)     : null,
      steps_done: row['steps_done'] ? JSON.parse(row['steps_done'] as string) : [],
    };
  }
  const lim  = args.limit ?? 20;
  const rows = (args.workflow_name
    ? d.prepare(`SELECT id,workflow_name,status,trigger_type,started_at,completed_at,error FROM wf_executions WHERE workflow_name=? ORDER BY started_at DESC LIMIT ?`).all(args.workflow_name, lim)
    : d.prepare(`SELECT id,workflow_name,status,trigger_type,started_at,completed_at,error FROM wf_executions ORDER BY started_at DESC LIMIT ?`).all(lim)
  ) as Record<string, unknown>[];
  d.close();
  return { executions: rows };
}

/**
 * Register or update a cron schedule for a named workflow.
 * The gateway's scheduler heartbeat reads wf_scheduled and fires due workflows.
 * Cron format: "* * * * *" (minute hour day month weekday).
 */
export async function workflow_schedule(
  args: { name: string; cron: string; enabled?: boolean },
  _ctx: unknown
): Promise<unknown> {
  loadDef(args.name); // validate exists before scheduling
  const d = openDb();
  d.prepare(`
    INSERT INTO wf_scheduled (workflow_name, cron, enabled) VALUES (?,?,?)
    ON CONFLICT(workflow_name) DO UPDATE SET cron=excluded.cron, enabled=excluded.enabled
  `).run(args.name, args.cron, args.enabled !== false ? 1 : 0);
  d.close();
  return {
    scheduled: true,
    workflow:  args.name,
    cron:      args.cron,
    enabled:   args.enabled !== false,
    note:      'Registered in wf_scheduled. Gateway scheduler will fire this on the next matching tick.',
  };
}
