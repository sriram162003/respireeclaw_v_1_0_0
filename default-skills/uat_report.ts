/**
 * uat_report skill
 * Structured test reporting for UAT scenario execution.
 * Records step-by-step results and generates TSD-style markdown reports.
 * Screenshots are stored silently in workspace and sent only on demand.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const REPORTS_DIR    = '/root/.aura/workspace/tsd_reports';
const SCREENSHOTS_DIR = '/root/.aura/workspace/screenshots';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StepRecord {
  step_number: number;
  description: string;
  expected: string | null;
  passed: boolean | null;   // null = skipped / awaiting input
  actual: string | null;
  screenshot_filename: string | null;
  notes: string | null;
  recorded_at: string;
}

interface UatReport {
  report_id: string;
  scenario_id: string;
  scenario_title: string;
  severity: string | null;
  user_role: string | null;
  started_at: string;
  finished_at: string | null;
  overall_result: string | null;
  comments: string | null;
  steps: StepRecord[];
}

interface MediaAttachment {
  type: 'photo' | 'document' | 'audio' | 'video' | 'voice' | 'animation';
  url: string;
  caption?: string;
  filename?: string;
}

interface SkillContext {
  node_id: string;
  channel?: {
    send: (node_id: string, text?: string, attachments?: MediaAttachment[]) => Promise<void>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureDirs(): Promise<void> {
  for (const d of [REPORTS_DIR, SCREENSHOTS_DIR]) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }
}

function reportPath(report_id: string): string {
  return join(REPORTS_DIR, `${report_id}.json`);
}

async function readReport(report_id: string): Promise<UatReport> {
  const p = reportPath(report_id);
  if (!existsSync(p)) throw new Error(`Report not found: ${report_id}`);
  return JSON.parse(await readFile(p, 'utf8')) as UatReport;
}

async function saveReport(report: UatReport): Promise<void> {
  await ensureDirs();
  await writeFile(reportPath(report.report_id), JSON.stringify(report, null, 2), 'utf8');
}

function trunc(s: string | undefined | null, max = 500): string | null {
  if (!s) return null;
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, max);
}

function stepIcon(passed: boolean | null): string {
  if (passed === true)  return 'PASS';
  if (passed === false) return 'FAIL';
  return 'SKIP';
}

function formatReport(r: UatReport): string {
  const lines: string[] = [];

  lines.push('# UAT Test Scenario Report', '');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Scenario | ${r.scenario_id} |`);
  lines.push(`| Title | ${r.scenario_title} |`);
  if (r.severity)   lines.push(`| Severity | ${r.severity} |`);
  if (r.user_role)  lines.push(`| User Role | ${r.user_role} |`);
  lines.push(`| Date Tested | ${r.finished_at ? r.finished_at.slice(0, 10) : 'In Progress'} |`);
  lines.push(`| Overall Result | **${r.overall_result ?? 'In Progress'}** |`);
  lines.push('');

  const passed  = r.steps.filter(s => s.passed === true).length;
  const failed  = r.steps.filter(s => s.passed === false).length;
  const skipped = r.steps.filter(s => s.passed === null).length;
  lines.push(`**Steps: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP**`, '');
  lines.push('## Steps', '');

  for (const step of r.steps) {
    lines.push(`### Step ${step.step_number} — ${stepIcon(step.passed)}`, '');
    lines.push(step.description, '');
    if (step.expected) lines.push(`**Expected:** ${step.expected}`, '');
    if (step.actual)   lines.push(`**Actual:** ${step.actual}`, '');
    if (step.screenshot_filename) lines.push(`**Screenshot:** \`${step.screenshot_filename}\``, '');
    if (step.notes)    lines.push(`**Notes:** ${step.notes}`, '');
    lines.push('---', '');
  }

  if (r.comments) {
    lines.push('## Comments', '', r.comments, '');
  }

  return lines.join('\n');
}

// ── start_report ──────────────────────────────────────────────────────────────

export async function start_report(
  args: {
    scenario_id: string;
    scenario_title: string;
    severity?: string;
    user_role?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDirs();

  const ts = Date.now();
  const report_id = `${args.scenario_id.replace(/[^a-z0-9_]/gi, '_')}_${ts}`;

  const report: UatReport = {
    report_id,
    scenario_id: args.scenario_id,
    scenario_title: args.scenario_title,
    severity: args.severity ?? null,
    user_role: args.user_role ?? null,
    started_at: new Date().toISOString(),
    finished_at: null,
    overall_result: null,
    comments: null,
    steps: [],
  };

  await saveReport(report);

  return {
    report_id,
    hint: `Use report_id "${report_id}" in all record_step and finish_report calls`,
  };
}

// ── record_step ───────────────────────────────────────────────────────────────

export async function record_step(
  args: {
    report_id: string;
    step_number: number;
    description: string;
    passed: boolean | null;
    expected?: string;
    actual?: string;
    screenshot_filename?: string;
    notes?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  const report = await readReport(args.report_id);

  const step: StepRecord = {
    step_number: args.step_number,
    description: trunc(args.description, 500) ?? '',
    expected: trunc(args.expected, 500),
    passed: args.passed,
    actual: trunc(args.actual, 500),
    screenshot_filename: args.screenshot_filename ?? null,
    notes: trunc(args.notes, 300),
    recorded_at: new Date().toISOString(),
  };

  const existing = report.steps.findIndex(s => s.step_number === args.step_number);
  if (existing >= 0) {
    report.steps[existing] = step;
  } else {
    report.steps.push(step);
    report.steps.sort((a, b) => a.step_number - b.step_number);
  }

  await saveReport(report);

  return {
    recorded: true,
    step_number: args.step_number,
    passed: args.passed,
    total_steps: report.steps.length,
  };
}

// ── finish_report ─────────────────────────────────────────────────────────────

export async function finish_report(
  args: {
    report_id: string;
    overall_result?: 'PASS' | 'FAIL';
    comments?: string;
  },
  ctx: SkillContext,
): Promise<unknown> {
  const report = await readReport(args.report_id);

  report.finished_at = new Date().toISOString();
  report.comments = args.comments ?? null;

  // Auto-calculate overall result if not provided
  if (args.overall_result) {
    report.overall_result = args.overall_result;
  } else {
    const anyFailed = report.steps.some(s => s.passed === false);
    const allPassed = report.steps.length > 0 && report.steps.every(s => s.passed === true);
    report.overall_result = anyFailed ? 'FAIL' : allPassed ? 'PASS' : 'INCOMPLETE';
  }

  await saveReport(report);

  const text = formatReport(report);

  // Send text report to chat (no screenshots — use send_report for those)
  await ctx.channel?.send(ctx.node_id, text);

  return {
    report_id: report.report_id,
    overall_result: report.overall_result,
    steps_pass: report.steps.filter(s => s.passed === true).length,
    steps_fail: report.steps.filter(s => s.passed === false).length,
    steps_skip: report.steps.filter(s => s.passed === null).length,
    hint: 'Call send_report with screenshots="all" or "failed" to send screenshots on demand',
  };
}

// ── get_report ────────────────────────────────────────────────────────────────

export async function get_report(
  args: { report_id: string },
  _ctx: unknown,
): Promise<unknown> {
  const report = await readReport(args.report_id);
  return {
    report,
    formatted: formatReport(report),
    steps_pass: report.steps.filter(s => s.passed === true).length,
    steps_fail: report.steps.filter(s => s.passed === false).length,
    steps_skip: report.steps.filter(s => s.passed === null).length,
  };
}

// ── list_reports ──────────────────────────────────────────────────────────────

export async function list_reports(
  args: { scenario_id?: string },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDirs();

  let files: string[];
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    return { reports: [], count: 0 };
  }

  const jsonFiles = files
    .filter(f => f.endsWith('.json'))
    .filter(f => !args.scenario_id || f.startsWith(args.scenario_id.replace(/[^a-z0-9_]/gi, '_')));

  const reports = await Promise.all(
    jsonFiles.map(async (f) => {
      try {
        const r = JSON.parse(
          await readFile(join(REPORTS_DIR, f), 'utf8'),
        ) as UatReport;
        return {
          report_id: r.report_id,
          scenario_id: r.scenario_id,
          scenario_title: r.scenario_title,
          user_role: r.user_role,
          overall_result: r.overall_result,
          started_at: r.started_at,
          finished_at: r.finished_at,
          steps_pass: r.steps.filter(s => s.passed === true).length,
          steps_fail: r.steps.filter(s => s.passed === false).length,
        };
      } catch {
        return null;
      }
    }),
  );

  const valid = reports
    .filter(Boolean)
    .sort((a, b) =>
      (b!.started_at ?? '').localeCompare(a!.started_at ?? ''),
    );

  return { reports: valid, count: valid.length };
}

// ── send_report ───────────────────────────────────────────────────────────────

export async function send_report(
  args: {
    report_id: string;
    screenshots?: 'all' | 'failed' | 'none';
  },
  ctx: SkillContext,
): Promise<unknown> {
  const report = await readReport(args.report_id);
  const mode = args.screenshots ?? 'none';

  // Send text report
  await ctx.channel?.send(ctx.node_id, formatReport(report));

  // Collect screenshots to send
  let stepsToSend: StepRecord[] = [];
  if (mode === 'all') {
    stepsToSend = report.steps.filter(s => s.screenshot_filename);
  } else if (mode === 'failed') {
    stepsToSend = report.steps.filter(s => s.passed === false && s.screenshot_filename);
  }

  if (stepsToSend.length > 0) {
    const attachments: MediaAttachment[] = stepsToSend
      .map(step => {
        const filepath = join(SCREENSHOTS_DIR, step.screenshot_filename!);
        if (!existsSync(filepath)) return null;
        return {
          type: 'photo' as const,
          url: `file://${filepath}`,
          caption: `Step ${step.step_number} — ${stepIcon(step.passed)}: ${step.description.slice(0, 80)}`,
          filename: step.screenshot_filename!,
        };
      })
      .filter(Boolean) as MediaAttachment[];

    if (attachments.length > 0) {
      // Send screenshots in batches of 5 (channel limits)
      for (let i = 0; i < attachments.length; i += 5) {
        await ctx.channel?.send(ctx.node_id, undefined, attachments.slice(i, i + 5));
      }
    }
  }

  return {
    sent: true,
    report_id: report.report_id,
    screenshots_sent: stepsToSend.length,
  };
}
