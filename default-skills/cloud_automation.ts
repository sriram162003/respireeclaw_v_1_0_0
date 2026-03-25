// EC2 Workflow Automation Skill — Real AWS SDK v3 implementation
// State persisted to SQLite. Credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Statistic,
} from '@aws-sdk/client-cloudwatch';
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';
import {
  AutoScalingClient,
  SetDesiredCapacityCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  RDSClient,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
  RebootDBInstanceCommand,
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
} from '@aws-sdk/client-rds';
import {
  LambdaClient,
  InvokeCommand,
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  ListClustersCommand,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DescribeAlarmsCommand,
  SetAlarmStateCommand,
} from '@aws-sdk/client-cloudwatch';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import yaml from 'js-yaml';

// ── Retry helper ───────────────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = String(err);
      // Don't retry on auth or validation errors
      if (msg.includes('UnauthorizedOperation') || msg.includes('InvalidParameter') || msg.includes('NotFound') || attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

// ── HMAC webhook signature validation ─────────────────────────────────────────
function validateWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

// ── Persistence ───────────────────────────────────────────────────────────────
const DB_PATH = path.join(os.homedir(), '.aura', 'memory', 'aura.db');

function openDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ec2_wf_state (
      workflow_id TEXT PRIMARY KEY,
      state_json  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ec2_wf_checkpoints (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      step        TEXT,
      state_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id  TEXT NOT NULL,
      operation    TEXT NOT NULL,
      service      TEXT NOT NULL,
      region       TEXT NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      duration_ms  INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    );
  `);
  return db;
}

function stateGet(workflow_id: string): Record<string, unknown> {
  const db = openDb();
  const row = db.prepare('SELECT state_json FROM ec2_wf_state WHERE workflow_id=?').get(workflow_id) as { state_json: string } | undefined;
  db.close();
  return row ? JSON.parse(row.state_json) : {};
}

function stateSet(workflow_id: string, state: Record<string, unknown>): void {
  const db = openDb();
  db.prepare('INSERT OR REPLACE INTO ec2_wf_state (workflow_id, state_json, updated_at) VALUES (?,?,?)').run(
    workflow_id, JSON.stringify(state), new Date().toISOString()
  );
  db.close();
}

function checkpointSave(workflow_id: string, step: string | undefined, state: Record<string, unknown>): string {
  const id = `chk-${randomUUID()}`;
  const db = openDb();
  db.prepare('INSERT INTO ec2_wf_checkpoints (id, workflow_id, step, state_json, created_at) VALUES (?,?,?,?,?)').run(
    id, workflow_id, step ?? null, JSON.stringify(state), new Date().toISOString()
  );
  db.close();
  return id;
}

function checkpointsGet(workflow_id: string): Array<{ id: string; step: string | null; state: Record<string, unknown>; created_at: string }> {
  const db = openDb();
  const rows = db.prepare('SELECT id, step, state_json, created_at FROM ec2_wf_checkpoints WHERE workflow_id=? ORDER BY created_at DESC').all(workflow_id) as Array<{ id: string; step: string | null; state_json: string; created_at: string }>;
  db.close();
  return rows.map(r => ({ id: r.id, step: r.step, state: JSON.parse(r.state_json), created_at: r.created_at }));
}

// ── Audit logging ──────────────────────────────────────────────────────────────
function auditLog(entry: { workflow_id: string; operation: string; service: string; region: string; status: 'success' | 'failed'; error?: string; duration_ms: number }): void {
  try {
    const db = openDb();
    db.prepare('INSERT INTO cloud_audit_log (workflow_id, operation, service, region, status, error, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      entry.workflow_id, entry.operation, entry.service, entry.region, entry.status, entry.error ?? null, entry.duration_ms, new Date().toISOString()
    );
    db.close();
  } catch { /* non-fatal */ }
}

// ── AWS Credentials Config ─────────────────────────────────────────────────────
const AWS_CREDS_FILE = path.join(os.homedir(), '.aura', 'config', 'aws-credentials.json');

interface AwsCreds {
  access_key_id: string;
  secret_access_key: string;
  region: string;
  session_token?: string;
}

// Derive a 32-byte key from the passphrase
function getDerivedKey(): Buffer {
  return scryptSync(process.env['AURA_CREDS_PASSPHRASE'] ?? 'aura-gateway-v1-default-passphrase', 'aura-salt-v1', 32);
}

function loadAwsCreds(): AwsCreds | null {
  try {
    if (fs.existsSync(AWS_CREDS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AWS_CREDS_FILE, 'utf8'));
      // Check if it's the new encrypted format
      if (raw && raw.iv && raw.tag && raw.ciphertext) {
        try {
          const key = getDerivedKey();
          const iv = Buffer.from(raw.iv, 'base64');
          const tag = Buffer.from(raw.tag, 'base64');
          const ciphertext = Buffer.from(raw.ciphertext, 'base64');
          const decipher = createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          return JSON.parse(decrypted.toString('utf8'));
        } catch {
          process.stderr.write('[cloud_automation] WARNING: Failed to decrypt AWS credentials — wrong key or corrupt file\n');
          return null;
        }
      }
      // Legacy plaintext format
      return raw as AwsCreds;
    }
  } catch { /* ignore */ }
  return null;
}

function saveAwsCreds(creds: AwsCreds): void {
  const dir = path.dirname(AWS_CREDS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const key = getDerivedKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(creds), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encrypted = {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  fs.writeFileSync(AWS_CREDS_FILE, JSON.stringify(encrypted, null, 2), 'utf8');
}

// ── AWS client helpers ─────────────────────────────────────────────────────────
function getAwsConfig(region: string) {
  const creds = loadAwsCreds();
  const config: { region: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } } = { region };

  if (creds) {
    config.credentials = {
      accessKeyId: creds.access_key_id,
      secretAccessKey: creds.secret_access_key,
      sessionToken: creds.session_token,
    };
  }
  return config;
}

function ec2(region: string) {
  return new EC2Client(getAwsConfig(region));
}
function cw(region: string) {
  return new CloudWatchClient(getAwsConfig(region));
}
function ssm(region: string) {
  return new SSMClient(getAwsConfig(region));
}
function asg(region: string) {
  return new AutoScalingClient(getAwsConfig(region));
}
function rds(region: string) {
  return new RDSClient(getAwsConfig(region));
}
function lambda(region: string) {
  return new LambdaClient(getAwsConfig(region));
}
function ecs(region: string) {
  return new ECSClient(getAwsConfig(region));
}
function s3(region: string) {
  return new S3Client(getAwsConfig(region));
}

// ── Dashboard helper ──────────────────────────────────────────────────────────
async function sendToDashboard(workflow_id: string, status: string, data: unknown): Promise<void> {
  try {
    // Read API key from keys.yaml for server-side auth
    const keysPath = path.join(os.homedir(), '.aura', 'keys.yaml');
    let apiKey = '';
    try {
      if (fs.existsSync(keysPath)) {
        const keysData = yaml.load(fs.readFileSync(keysPath, 'utf8')) as { keys?: Array<{ key: string }> };
        apiKey = keysData.keys?.[0]?.key ?? '';
      }
    } catch { /* ignore */ }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    await fetch('http://localhost:3002/dashboard2/api/workflow-update', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workflow_id, status, data, timestamp: new Date().toISOString(), skill: 'ec2_workflow_automation' }),
    });
  } catch {
    // dashboard may not be open — not a fatal error
  }
}

// ── Tool: set_aws_credentials ───────────────────────────────────────────────
// Saves AWS credentials to a config file so subsequent AWS operations can use them
export async function set_aws_credentials(args: {
  access_key_id: string;
  secret_access_key: string;
  region: string;
  session_token?: string;
}, _ctx: unknown): Promise<unknown> {
  const { access_key_id, secret_access_key, region, session_token } = args;

  if (!access_key_id || !secret_access_key || !region) {
    throw new Error('access_key_id, secret_access_key, and region are required');
  }

  const creds: AwsCreds = {
    access_key_id,
    secret_access_key,
    region,
    session_token,
  };

  saveAwsCreds(creds);

  return {
    success: true,
    message: 'AWS credentials saved successfully (AES-256-GCM encrypted)',
    saved_to: AWS_CREDS_FILE,
    region,
    note: 'Restart the gateway or wait for skill reload for changes to take effect'
  };
}

// ── Tool: get_aws_credentials_status ─────────────────────────────────────────
// Check if AWS credentials are configured
export async function get_aws_credentials_status(_args: unknown, _ctx: unknown): Promise<unknown> {
  const creds = loadAwsCreds();

  if (!creds) {
    return {
      configured: false,
      message: 'No AWS credentials configured. Use set_aws_credentials to add them.',
      location: AWS_CREDS_FILE,
    };
  }

  return {
    configured: true,
    region: creds.region,
    has_session_token: !!creds.session_token,
    access_key_prefix: creds.access_key_id.substring(0, 8) + '...',
    location: AWS_CREDS_FILE,
  };
}

// ── Tool: execute_ec2_operation ───────────────────────────────────────────────
export async function execute_ec2_operation(args: {
  operation: string;
  instance_ids: string[];
  region: string;
  workflow_id: string;
  dry_run?: boolean;
}, _ctx: unknown): Promise<unknown> {
  const { operation, instance_ids, region, workflow_id, dry_run } = args;

  if (!['start', 'stop', 'restart', 'terminate'].includes(operation)) {
    throw new Error(`Invalid operation: ${operation}. Must be start | stop | restart | terminate`);
  }

  // Dry run support
  if (dry_run === true) {
    await sendToDashboard(workflow_id, 'running', { step: 'ec2_lifecycle', operation, target_count: instance_ids.length, targets: instance_ids, dry_run: true });
    await sendToDashboard(workflow_id, 'completed', { step: 'ec2_lifecycle', operation, dry_run: true });
    return { success: true, dry_run: true, would_have_executed: operation, targets: instance_ids, message: 'Dry run — no changes made' };
  }

  await sendToDashboard(workflow_id, 'running', { step: 'ec2_lifecycle', operation, target_count: instance_ids.length, targets: instance_ids });

  const client = ec2(region);
  let result: unknown;
  const t0 = Date.now();

  try {
    if (operation === 'start') {
      const res = await withRetry(() => client.send(new StartInstancesCommand({ InstanceIds: instance_ids })));
      result = res.StartingInstances?.map(i => ({ id: i.InstanceId, state: i.CurrentState?.Name, prev: i.PreviousState?.Name }));

    } else if (operation === 'stop') {
      const res = await withRetry(() => client.send(new StopInstancesCommand({ InstanceIds: instance_ids })));
      result = res.StoppingInstances?.map(i => ({ id: i.InstanceId, state: i.CurrentState?.Name, prev: i.PreviousState?.Name }));

    } else if (operation === 'restart') {
      await withRetry(() => client.send(new RebootInstancesCommand({ InstanceIds: instance_ids })));
      result = instance_ids.map(id => ({ id, state: 'rebooting' }));

    } else {
      const res = await withRetry(() => client.send(new TerminateInstancesCommand({ InstanceIds: instance_ids })));
      result = res.TerminatingInstances?.map(i => ({ id: i.InstanceId, state: i.CurrentState?.Name, prev: i.PreviousState?.Name }));
    }

    // Persist state
    const prev = stateGet(workflow_id);
    stateSet(workflow_id, { ...prev, last_operation: operation, instances: instance_ids, region, result, updated_at: new Date().toISOString() });

    await sendToDashboard(workflow_id, 'completed', { step: 'ec2_lifecycle', operation, result });
    auditLog({ workflow_id, operation, service: 'ec2', region, status: 'success', duration_ms: Date.now() - t0 });

    return { success: true, workflow_id, operation, affected_instances: instance_ids.length, details: result };

  } catch (err) {
    auditLog({ workflow_id, operation, service: 'ec2', region, status: 'failed', error: String(err), duration_ms: Date.now() - t0 });
    await sendToDashboard(workflow_id, 'failed', { step: 'ec2_lifecycle', operation, error: String(err) });
    throw err;
  }
}

// ── Tool: spawn_agent_team ────────────────────────────────────────────────────
// Runs a list of AWS tasks in parallel (Promise.allSettled).
// Supported task_types: describe_instances, check_health, start_instances,
//   stop_instances, get_metrics, run_ssm_command, scale_asg.
export async function spawn_agent_team(args: {
  tasks: Array<{ task_type: string; instance_id?: string; instance_ids?: string[]; region: string; [k: string]: unknown }>;
  workflow_id: string;
  concurrency_limit?: number;
}, _ctx: unknown): Promise<unknown> {
  const { tasks, workflow_id, concurrency_limit = 5 } = args;
  if (!tasks?.length) throw new Error('No tasks provided');

  const limited = tasks.slice(0, Math.max(1, concurrency_limit));

  await sendToDashboard(workflow_id, 'running', { step: 'agent_parallel_execution', task_count: limited.length });

  // Run tasks in parallel
  const settled = await Promise.allSettled(limited.map(async (task, idx) => {
    const region = task['region'] as string ?? 'us-east-1';
    const ids = (task['instance_ids'] as string[] | undefined) ?? (task['instance_id'] ? [task['instance_id'] as string] : []);

    switch (task.task_type) {
      case 'describe_instances': {
        const res = await withRetry(() => ec2(region).send(new DescribeInstancesCommand({ InstanceIds: ids.length ? ids : undefined })));
        const instances = res.Reservations?.flatMap(r => r.Instances ?? []).map(i => ({
          id: i.InstanceId, state: i.State?.Name, type: i.InstanceType,
          az: i.Placement?.AvailabilityZone, public_ip: i.PublicIpAddress, launch: i.LaunchTime,
        }));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: instances };
      }

      case 'check_health': {
        const res = await withRetry(() => ec2(region).send(new DescribeInstanceStatusCommand({ InstanceIds: ids.length ? ids : undefined, IncludeAllInstances: true })));
        const statuses = res.InstanceStatuses?.map(s => ({
          id: s.InstanceId,
          instance_status: s.InstanceStatus?.Status,
          system_status: s.SystemStatus?.Status,
          state: s.InstanceState?.Name,
        }));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: statuses };
      }

      case 'start_instances': {
        const res = await withRetry(() => ec2(region).send(new StartInstancesCommand({ InstanceIds: ids })));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: res.StartingInstances?.map(i => ({ id: i.InstanceId, state: i.CurrentState?.Name })) };
      }

      case 'stop_instances': {
        const res = await withRetry(() => ec2(region).send(new StopInstancesCommand({ InstanceIds: ids })));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: res.StoppingInstances?.map(i => ({ id: i.InstanceId, state: i.CurrentState?.Name })) };
      }

      case 'get_metrics': {
        const metric = (task['metric'] as string) ?? 'CPUUtilization';
        const end = new Date();
        const start = new Date(end.getTime() - 10 * 60 * 1000);
        const res = await withRetry(() => cw(region).send(new GetMetricStatisticsCommand({
          Namespace: 'AWS/EC2',
          MetricName: metric,
          Dimensions: ids.map(id => ({ Name: 'InstanceId', Value: id })),
          StartTime: start, EndTime: end,
          Period: 300,
          Statistics: ['Average', 'Maximum'] as Statistic[],
        })));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: { metric, datapoints: res.Datapoints } };
      }

      case 'run_ssm_command': {
        const command = (task['command'] as string) ?? 'echo ok';
        const res = await withRetry(() => ssm(region).send(new SendCommandCommand({
          InstanceIds: ids, DocumentName: 'AWS-RunShellScript',
          Parameters: { commands: [command] },
        })));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: { command_id: res.Command?.CommandId, status: res.Command?.Status } };
      }

      case 'scale_asg': {
        const asgName = task['asg_name'] as string;
        const desired = Number(task['desired_capacity']);
        if (!asgName || desired === undefined) throw new Error('scale_asg requires asg_name and desired_capacity');
        if (!Number.isInteger(desired) || desired < 0 || desired > 10000) {
          throw new Error(`scale_asg: desired_capacity must be a non-negative integer, got: ${task['desired_capacity']}`);
        }
        await withRetry(() => asg(region).send(new SetDesiredCapacityCommand({ AutoScalingGroupName: asgName, DesiredCapacity: desired })));
        return { task_id: `task-${idx}`, task_type: task.task_type, status: 'completed', result: { asg_name: asgName, desired_capacity: desired } };
      }

      default:
        throw new Error(`Unknown task_type: ${task.task_type}`);
    }
  }));

  const results = settled.map((s, idx) =>
    s.status === 'fulfilled'
      ? s.value
      : { task_id: `task-${idx}`, task_type: limited[idx]?.task_type, status: 'failed', error: String((s as PromiseRejectedResult).reason) }
  );

  await sendToDashboard(workflow_id, 'completed', {
    step: 'agent_parallel_execution',
    agents_spawned: limited.length,
    completed_tasks: results.filter(r => r.status === 'completed').length,
    failed_tasks: results.filter(r => r.status === 'failed').length,
  });

  return { success: true, workflow_id, parallel_execution: true, results };
}

// ── Tool: update_dashboard ────────────────────────────────────────────────────
export async function update_dashboard(args: {
  workflow_id: string;
  status: string;
  data?: unknown;
  timestamp?: string;
}, _ctx: unknown): Promise<unknown> {
  const { workflow_id, status, data = {}, timestamp = new Date().toISOString() } = args;
  await sendToDashboard(workflow_id, status, { ...(data as object), timestamp });
  return { success: true, workflow_id, dashboard_endpoint: 'localhost:3002/dashboard2', status };
}

// ── Tool: process_webhook ─────────────────────────────────────────────────────
export async function process_webhook(args: {
  event_type: string;
  payload: Record<string, unknown>;
  signature?: string;
}, _ctx: unknown): Promise<unknown> {
  const { event_type, payload, signature } = args;

  // HMAC-SHA256 validation if WEBHOOK_SECRET is set
  if (signature && process.env['WEBHOOK_SECRET']) {
    if (!validateWebhookSignature(JSON.stringify(payload), signature, process.env['WEBHOOK_SECRET']!)) {
      throw new Error('Webhook signature validation failed');
    }
  }

  const workflow_id = `webhook-${event_type}-${randomUUID()}`;
  stateSet(workflow_id, { trigger: 'webhook', event_type, payload, created_at: new Date().toISOString(), status: 'triggered' });

  await sendToDashboard(workflow_id, 'pending', {
    trigger: 'webhook', event_type,
    instance_ids: payload['instance_ids'] ?? [],
    auto_execute: payload['auto_execute'] ?? false,
  });

  return { success: true, workflow_id, event_type, acknowledged: true, message: 'Webhook processed and workflow initialised' };
}

// ── Tool: manage_workflow_state ───────────────────────────────────────────────
export async function manage_workflow_state(args: {
  action: string;
  workflow_id: string;
  state_data?: Record<string, unknown>;
  step?: string;
}, _ctx: unknown): Promise<unknown> {
  const { action, workflow_id, state_data, step } = args;

  if (!['get', 'set', 'checkpoint', 'rollback'].includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be get | set | checkpoint | rollback`);
  }

  switch (action) {
    case 'get': {
      const state = stateGet(workflow_id);
      const checkpoints = checkpointsGet(workflow_id);
      return { exists: Object.keys(state).length > 0, workflow_id, state, checkpoints };
    }

    case 'set': {
      if (!state_data) throw new Error('state_data required for set action');
      const merged = { ...stateGet(workflow_id), ...state_data, step: step ?? 'unknown', updated_at: new Date().toISOString() };
      stateSet(workflow_id, merged);
      return { success: true, action: 'set', workflow_id, state: merged };
    }

    case 'checkpoint': {
      const current = stateGet(workflow_id);
      const id = checkpointSave(workflow_id, step, current);
      return { success: true, action: 'checkpoint', checkpoint_id: id, workflow_id };
    }

    case 'rollback': {
      const checkpoints = checkpointsGet(workflow_id);
      if (!checkpoints.length) throw new Error(`No checkpoints available for rollback: ${workflow_id}`);
      const last = checkpoints[0]!; // already sorted DESC
      const restored = { ...last.state, rolled_back: true, rollback_to: last.id, rollback_time: new Date().toISOString() };
      stateSet(workflow_id, restored);
      await sendToDashboard(workflow_id, 'rolled_back', { restored_to_checkpoint: last.id, restored_step: last.step });
      return { success: true, action: 'rollback', workflow_id, restored_checkpoint: last.id, state: restored };
    }
  }

  throw new Error('Unexpected action path');
}

// ── Tool: evaluate_conditions ─────────────────────────────────────────────────
// Pulls real CloudWatch metrics for the instance and evaluates conditions.
export async function evaluate_conditions(args: {
  instance_id: string;
  conditions: Array<{ metric: string; operator: string; threshold: number }>;
  region: string;
}, _ctx: unknown): Promise<unknown> {
  const { instance_id, conditions, region } = args;

  const end = new Date();
  const start = new Date(end.getTime() - 10 * 60 * 1000); // last 10 min

  // Fetch all distinct metrics in parallel
  const uniqueMetrics = [...new Set(conditions.map(c => c.metric))];
  const metricValues: Record<string, number> = {};
  const metricAvailable: Record<string, boolean> = {};

  await Promise.all(uniqueMetrics.map(async (metric) => {
    try {
      const stat: Statistic = metric === 'StatusCheckFailed' ? 'Maximum' : 'Average';
      const res = await withRetry(() => cw(region).send(new GetMetricStatisticsCommand({
        Namespace: 'AWS/EC2',
        MetricName: metric,
        Dimensions: [{ Name: 'InstanceId', Value: instance_id }],
        StartTime: start, EndTime: end,
        Period: 300,
        Statistics: [stat],
      })));
      const points = res.Datapoints ?? [];
      if (points.length) {
        const latest = points.sort((a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0))[0]!;
        metricValues[metric] = stat === 'Maximum' ? (latest.Maximum ?? 0) : (latest.Average ?? 0);
        metricAvailable[metric] = true;
      } else {
        metricValues[metric] = 0;
        metricAvailable[metric] = false;
      }
    } catch {
      metricValues[metric] = 0;
      metricAvailable[metric] = false;
    }
  }));

  const evaluations = conditions.map(cond => {
    const actual = metricValues[cond.metric] ?? 0;
    const available = metricAvailable[cond.metric] ?? false;

    if (!available) {
      return {
        metric: cond.metric,
        operator: cond.operator,
        threshold: cond.threshold,
        actual_value: 0,
        passed: false,
        data_available: false,
        note: 'No CloudWatch data in last 10 minutes — metric unavailable',
      };
    }

    let passed = false;
    switch (cond.operator) {
      case 'gt':  passed = actual >  cond.threshold; break;
      case 'lt':  passed = actual <  cond.threshold; break;
      case 'gte': passed = actual >= cond.threshold; break;
      case 'lte': passed = actual <= cond.threshold; break;
      case 'eq':  passed = actual === cond.threshold; break;
      case 'ne':  passed = actual !== cond.threshold; break;
    }
    return { metric: cond.metric, operator: cond.operator, threshold: cond.threshold, actual_value: actual, passed, data_available: true };
  });

  const allPassed = evaluations.every(e => e.passed);

  return {
    instance_id, region,
    all_conditions_met: allPassed,
    evaluations,
    workflow_decision: allPassed ? 'continue' : 'remediate',
    timestamp: new Date().toISOString(),
  };
}

// ── Tool: execute_rds_operation ─────────────────────────────────────────────────
export async function execute_rds_operation(args: {
  operation: string;
  identifier: string;
  region: string;
  workflow_id: string;
  dry_run?: boolean;
}, _ctx: unknown): Promise<unknown> {
  const { operation, identifier, region, workflow_id, dry_run } = args;

  if (!['start', 'stop', 'reboot', 'describe'].includes(operation)) {
    throw new Error(`Invalid operation: ${operation}. Must be start | stop | reboot | describe`);
  }

  // Dry run support
  if (dry_run === true) {
    await sendToDashboard(workflow_id, 'running', { step: 'rds_lifecycle', operation, target: identifier, dry_run: true });
    await sendToDashboard(workflow_id, 'completed', { step: 'rds_lifecycle', operation, dry_run: true });
    return { success: true, dry_run: true, would_have_executed: operation, targets: [identifier], message: 'Dry run — no changes made' };
  }

  await sendToDashboard(workflow_id, 'running', { step: 'rds_lifecycle', operation, target: identifier });

  const client = rds(region);
  let result: unknown;
  const t0 = Date.now();

  try {
    if (operation === 'describe') {
      const res = await withRetry(() => client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })));
      const db = res.DBInstances?.[0];
      result = db ? {
        id: db.DBInstanceIdentifier,
        status: db.DBInstanceStatus,
        engine: db.Engine,
        engine_version: db.EngineVersion,
        endpoint: db.Endpoint?.Address,
        port: db.Endpoint?.Port,
        multi_az: db.MultiAZ,
        storage: db.AllocatedStorage,
      } : null;

    } else if (operation === 'start') {
      const res = await withRetry(() => client.send(new StartDBInstanceCommand({ DBInstanceIdentifier: identifier })));
      result = { id: identifier, status: res.DBInstance?.DBInstanceStatus };

    } else if (operation === 'stop') {
      const res = await withRetry(() => client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: identifier })));
      result = { id: identifier, status: res.DBInstance?.DBInstanceStatus };

    } else if (operation === 'reboot') {
      const res = await withRetry(() => client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: identifier })));
      result = { id: identifier, status: res.DBInstance?.DBInstanceStatus };
    }

    const prev = stateGet(workflow_id);
    stateSet(workflow_id, { ...prev, last_operation: operation, target: identifier, result, updated_at: new Date().toISOString() });

    await sendToDashboard(workflow_id, 'completed', { step: 'rds_lifecycle', operation, result });
    auditLog({ workflow_id, operation, service: 'rds', region, status: 'success', duration_ms: Date.now() - t0 });

    return { success: true, workflow_id, operation, target: identifier, result };

  } catch (err) {
    auditLog({ workflow_id, operation, service: 'rds', region, status: 'failed', error: String(err), duration_ms: Date.now() - t0 });
    await sendToDashboard(workflow_id, 'failed', { step: 'rds_lifecycle', operation, error: String(err) });
    throw err;
  }
}

// ── Tool: execute_lambda_operation ─────────────────────────────────────────────
export async function execute_lambda_operation(args: {
  operation: string;
  function_name: string;
  region: string;
  payload?: Record<string, unknown>;
  workflow_id: string;
}, _ctx: unknown): Promise<unknown> {
  const { operation, function_name, region, payload, workflow_id } = args;

  if (!['invoke', 'list', 'get_config'].includes(operation)) {
    throw new Error(`Invalid operation: ${operation}. Must be invoke | list | get_config`);
  }

  await sendToDashboard(workflow_id, 'running', { step: 'lambda_operation', operation, function_name });

  const client = lambda(region);
  let result: unknown;
  const t0 = Date.now();

  try {
    if (operation === 'list') {
      const res = await withRetry(() => client.send(new ListFunctionsCommand({})));
      result = (res.Functions ?? []).map(f => ({
        name: f.FunctionName,
        runtime: f.Runtime,
        handler: f.Handler,
        memory: f.MemorySize,
        timeout: f.Timeout,
        state: f.State,
      }));

    } else if (operation === 'get_config') {
      const res = await withRetry(() => client.send(new GetFunctionConfigurationCommand({ FunctionName: function_name })));
      result = {
        name: res.FunctionName,
        runtime: res.Runtime,
        handler: res.Handler,
        memory: res.MemorySize,
        timeout: res.Timeout,
        role: res.Role,
        env: res.Environment?.Variables,
        state: res.State,
        last_modified: res.LastModified,
      };

    } else if (operation === 'invoke') {
      const payloadStr = payload ? JSON.stringify(payload) : '{}';
      const res = await withRetry(() => client.send(new InvokeCommand({
        FunctionName: function_name,
        Payload: new TextEncoder().encode(payloadStr),
        LogType: 'Tail',
      })));

      const logs = res.LogResult ? new TextDecoder().decode(res.LogResult) : null;
      const responsePayload = res.Payload ? JSON.parse(new TextDecoder().decode(res.Payload)) : null;

      result = {
        status: res.StatusCode,
        logs,
        response: responsePayload,
      };
    }

    const prev = stateGet(workflow_id);
    stateSet(workflow_id, { ...prev, last_operation: operation, function_name, result, updated_at: new Date().toISOString() });

    await sendToDashboard(workflow_id, 'completed', { step: 'lambda_operation', operation, result });
    auditLog({ workflow_id, operation, service: 'lambda', region, status: 'success', duration_ms: Date.now() - t0 });

    return { success: true, workflow_id, operation, function_name, result };

  } catch (err) {
    auditLog({ workflow_id, operation, service: 'lambda', region, status: 'failed', error: String(err), duration_ms: Date.now() - t0 });
    await sendToDashboard(workflow_id, 'failed', { step: 'lambda_operation', operation, error: String(err) });
    throw err;
  }
}

// ── Tool: execute_ecs_operation ─────────────────────────────────────────────────
export async function execute_ecs_operation(args: {
  operation: string;
  cluster: string;
  task_definition?: string;
  task_arn?: string;
  region: string;
  workflow_id: string;
  overrides?: Record<string, unknown>;
}, _ctx: unknown): Promise<unknown> {
  const { operation, cluster, task_definition, task_arn, region, workflow_id, overrides } = args;

  if (!['run_task', 'stop_task', 'describe', 'list_clusters', 'list_tasks'].includes(operation)) {
    throw new Error(`Invalid operation: ${operation}. Must be run_task | stop_task | describe | list_clusters | list_tasks`);
  }

  await sendToDashboard(workflow_id, 'running', { step: 'ecs_operation', operation, cluster });

  const client = ecs(region);
  let result: unknown;
  const t0 = Date.now();

  try {
    if (operation === 'list_clusters') {
      const res = await withRetry(() => client.send(new ListClustersCommand({})));
      result = res.clusterArns;

    } else if (operation === 'list_tasks') {
      const res = await withRetry(() => client.send(new ListTasksCommand({ cluster })));
      result = res.taskArns;

    } else if (operation === 'run_task') {
      if (!task_definition) throw new Error('task_definition required for run_task');
      const res = await withRetry(() => client.send(new RunTaskCommand({
        cluster,
        taskDefinition: task_definition,
        overrides: overrides ? { containerOverrides: overrides['containerOverrides'] as never } : undefined,
      })));
      result = {
        tasks: res.tasks?.map(t => ({ arn: t.taskArn, status: t.lastStatus })),
        failures: res.failures,
      };

    } else if (operation === 'stop_task') {
      if (!task_arn) throw new Error('task_arn required for stop_task');
      const res = await withRetry(() => client.send(new StopTaskCommand({ cluster, taskArn: task_arn })));
      result = { task: res.task?.taskArn, status: res.task?.lastStatus };

    } else if (operation === 'describe') {
      if (!task_arn) throw new Error('task_arn required for describe');
      const res = await withRetry(() => client.send(new DescribeTasksCommand({ cluster, tasks: [task_arn] })));
      const task = res.tasks?.[0];
      result = task ? {
        arn: task.taskArn,
        status: task.lastStatus,
        desired_status: task.desiredStatus,
        containers: task.containers?.map(c => ({ name: c.name, status: c.lastStatus })),
      } : null;
    }

    const prev = stateGet(workflow_id);
    stateSet(workflow_id, { ...prev, last_operation: operation, cluster, result, updated_at: new Date().toISOString() });

    await sendToDashboard(workflow_id, 'completed', { step: 'ecs_operation', operation, result });
    auditLog({ workflow_id, operation, service: 'ecs', region, status: 'success', duration_ms: Date.now() - t0 });

    return { success: true, workflow_id, operation, cluster, result };

  } catch (err) {
    auditLog({ workflow_id, operation, service: 'ecs', region, status: 'failed', error: String(err), duration_ms: Date.now() - t0 });
    await sendToDashboard(workflow_id, 'failed', { step: 'ecs_operation', operation, error: String(err) });
    throw err;
  }
}

// ── Tool: execute_s3_operation ──────────────────────────────────────────────────
export async function execute_s3_operation(args: {
  operation: string;
  bucket?: string;
  key?: string;
  content?: string;
  region?: string;
  workflow_id: string;
}, _ctx: unknown): Promise<unknown> {
  const { operation, bucket, key, content, region = 'us-east-1', workflow_id } = args;

  if (!['list_buckets', 'list_objects', 'get_object', 'put_object', 'delete_object'].includes(operation)) {
    throw new Error(`Invalid operation: ${operation}. Must be list_buckets | list_objects | get_object | put_object | delete_object`);
  }

  await sendToDashboard(workflow_id, 'running', { step: 's3_operation', operation, bucket: bucket ?? 'all' });

  const client = s3(region);
  let result: unknown;
  const t0 = Date.now();

  try {
    if (operation === 'list_buckets') {
      const res = await withRetry(() => client.send(new ListBucketsCommand({})));
      result = res.Buckets?.map(b => ({ name: b.Name, created: b.CreationDate }));

    } else if (operation === 'list_objects') {
      if (!bucket) throw new Error('bucket required for list_objects');
      const res = await withRetry(() => client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 100 })));
      result = (res.Contents ?? []).map(o => ({
        key: o.Key,
        size: o.Size,
        last_modified: o.LastModified,
      }));

    } else if (operation === 'get_object') {
      if (!bucket || !key) throw new Error('bucket and key required for get_object');
      const res = await withRetry(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
      const bodyStr = await res.Body?.transformToString();
      result = {
        content: bodyStr,
        content_type: res.ContentType,
        content_length: res.ContentLength,
      };

    } else if (operation === 'put_object') {
      if (!bucket || !key || content === undefined) throw new Error('bucket, key, and content required for put_object');
      const res = await withRetry(() => client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: 'text/plain',
      })));
      result = { etag: res.ETag, version_id: res.VersionId };

    } else if (operation === 'delete_object') {
      if (!bucket || !key) throw new Error('bucket and key required for delete_object');
      const res = await withRetry(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
      result = { delete_marker: res.DeleteMarker, version_id: res.VersionId };
    }

    const prev = stateGet(workflow_id);
    stateSet(workflow_id, { ...prev, last_operation: operation, bucket, key, result, updated_at: new Date().toISOString() });

    await sendToDashboard(workflow_id, 'completed', { step: 's3_operation', operation, result });
    auditLog({ workflow_id, operation, service: 's3', region, status: 'success', duration_ms: Date.now() - t0 });

    return { success: true, workflow_id, operation, bucket, key, result };

  } catch (err) {
    auditLog({ workflow_id, operation, service: 's3', region, status: 'failed', error: String(err), duration_ms: Date.now() - t0 });
    await sendToDashboard(workflow_id, 'failed', { step: 's3_operation', operation, error: String(err) });
    throw err;
  }
}

// ── Tool: manage_cloudwatch_alarms ──────────────────────────────────────────────
export async function manage_cloudwatch_alarms(args: {
  operation: string;
  alarm_names?: string[];
  alarm_name?: string;
  state_value?: string;
  state_reason?: string;
  region?: string;
  workflow_id: string;
}, _ctx: unknown): Promise<unknown> {
  const { operation, alarm_names, alarm_name, state_value, state_reason, region = 'us-east-1', workflow_id } = args;

  if (!['describe_alarms', 'set_state'].includes(operation)) {
    throw new Error(`Invalid operation: ${operation}. Must be describe_alarms | set_state`);
  }

  await sendToDashboard(workflow_id, 'running', { step: 'cloudwatch_alarms', operation });

  const client = cw(region);
  let result: unknown;
  const t0 = Date.now();

  try {
    if (operation === 'describe_alarms') {
      const res = await withRetry(() => client.send(new DescribeAlarmsCommand({
        AlarmNames: alarm_names,
        MaxRecords: 100,
      })));
      result = (res.MetricAlarms ?? []).map(a => ({
        name: a.AlarmName,
        state: a.StateValue,
        reason: a.StateReason,
        metric: a.MetricName,
        namespace: a.Namespace,
        threshold: a.Threshold,
      }));

    } else if (operation === 'set_state') {
      if (!alarm_name || !state_value || !state_reason) {
        throw new Error('alarm_name, state_value, and state_reason required for set_state');
      }
      await withRetry(() => client.send(new SetAlarmStateCommand({
        AlarmName: alarm_name,
        StateValue: state_value as 'OK' | 'ALARM' | 'INSUFFICIENT_DATA',
        StateReason: state_reason,
      })));
      result = { alarm_name, state_value, state_reason };
    }

    const prev = stateGet(workflow_id);
    stateSet(workflow_id, { ...prev, last_operation: operation, result, updated_at: new Date().toISOString() });

    await sendToDashboard(workflow_id, 'completed', { step: 'cloudwatch_alarms', operation, result });
    auditLog({ workflow_id, operation, service: 'cloudwatch', region, status: 'success', duration_ms: Date.now() - t0 });

    return { success: true, workflow_id, operation, result };

  } catch (err) {
    auditLog({ workflow_id, operation, service: 'cloudwatch', region, status: 'failed', error: String(err), duration_ms: Date.now() - t0 });
    await sendToDashboard(workflow_id, 'failed', { step: 'cloudwatch_alarms', operation, error: String(err) });
    throw err;
  }
}

// ── Tool: resolve_resource_names ──────────────────────────────────────────────
export async function resolve_resource_names(args: {
  names: string[];
  region: string;
  resource_type?: string; // default 'ec2'
}, _ctx: unknown): Promise<unknown> {
  const { names, region, resource_type = 'ec2' } = args;
  const client = ec2(region);
  const res = await withRetry(() => client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Name', Values: names },
      { Name: 'instance-state-name', Values: ['running', 'stopped', 'stopping', 'starting', 'pending'] },
    ],
  })));
  const instances = res.Reservations?.flatMap(r => r.Instances ?? []).map(i => ({
    instance_id: i.InstanceId,
    name: i.Tags?.find(t => t.Key === 'Name')?.Value ?? '(unnamed)',
    state: i.State?.Name,
    type: i.InstanceType,
    region,
  })) ?? [];
  return { resolved: instances, count: instances.length, region, resource_type };
}

// ── Tool: get_audit_log ───────────────────────────────────────────────────────
export async function get_audit_log(args: {
  workflow_id?: string;
  service?: string;
  status?: string;
  since_hours?: number;
  limit?: number;
}, _ctx: unknown): Promise<unknown> {
  const { workflow_id, service, status, since_hours, limit = 100 } = args;
  const db = openDb();
  let sql = 'SELECT * FROM cloud_audit_log WHERE 1=1';
  const params: unknown[] = [];
  if (workflow_id) { sql += ' AND workflow_id = ?'; params.push(workflow_id); }
  if (service)     { sql += ' AND service = ?'; params.push(service); }
  if (status)      { sql += ' AND status = ?'; params.push(status); }
  if (since_hours) { sql += ' AND created_at >= ?'; params.push(new Date(Date.now() - since_hours * 3600_000).toISOString()); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  db.close();
  return { entries: rows, count: rows.length };
}
