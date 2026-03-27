/**
 * tsd_runner skill
 * Reporting layer for TSD (Test Scenario Document) test execution.
 * The agent orchestrates test steps via playwright_testing tools and
 * calls this skill to record results and generate the final report.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const REPORTS_DIR = '/root/.aura/workspace/tsd_reports';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StepRecord {
  step_number: number;
  description: string;
  expected: string | null;
  passed: boolean | null;
  actual: string | null;
  screenshot_filename: string | null;
  notes: string | null;
  recorded_at: string;
}

interface TsdReport {
  report_id: string;
  scenario_id: string;
  scenario_title: string;
  severity: string | null;
  user_role: string | null;
  session_name: string | null;
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

async function ensureDir(): Promise<void> {
  if (!existsSync(REPORTS_DIR)) await mkdir(REPORTS_DIR, { recursive: true });
}

function reportPath(report_id: string): string {
  return join(REPORTS_DIR, `${report_id}.json`);
}

function mdPath(report_id: string): string {
  return join(REPORTS_DIR, `${report_id}.md`);
}

async function readReport(report_id: string): Promise<TsdReport> {
  const p = reportPath(report_id);
  if (!existsSync(p)) throw new Error(`Report not found: ${report_id}`);
  return JSON.parse(await readFile(p, 'utf8')) as TsdReport;
}

async function saveReport(report: TsdReport): Promise<void> {
  await ensureDir();
  await writeFile(reportPath(report.report_id), JSON.stringify(report, null, 2), 'utf8');
}

function stepIcon(passed: boolean | null): string {
  if (passed === true)  return 'PASS';
  if (passed === false) return 'FAIL';
  return 'SKIP';
}

function formatReport(r: TsdReport): string {
  const lines: string[] = [];

  lines.push(`# Test Scenario Report`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Scenario No. | ${r.scenario_id} |`);
  lines.push(`| Title | ${r.scenario_title} |`);
  if (r.severity)     lines.push(`| Severity | ${r.severity} |`);
  if (r.user_role)    lines.push(`| User Role | ${r.user_role} |`);
  lines.push(`| Date Tested | ${r.finished_at ? r.finished_at.slice(0, 10) : 'In Progress'} |`);
  lines.push(`| Overall Result | **${r.overall_result ?? 'In Progress'}** |`);
  lines.push('');

  const passed = r.steps.filter(s => s.passed === true).length;
  const failed = r.steps.filter(s => s.passed === false).length;
  const skipped = r.steps.filter(s => s.passed === null).length;
  lines.push(`**Steps: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP**`);
  lines.push('');

  lines.push('## Steps');
  lines.push('');

  for (const step of r.steps) {
    lines.push(`### Step ${step.step_number} — ${stepIcon(step.passed)}`);
    lines.push('');
    lines.push(step.description);
    lines.push('');
    if (step.expected) {
      lines.push(`**Expected:** ${step.expected}`);
      lines.push('');
    }
    if (step.actual) {
      lines.push(`**Actual:** ${step.actual}`);
      lines.push('');
    }
    if (step.screenshot_filename) {
      lines.push(`**Screenshot:** \`${step.screenshot_filename}\``);
      lines.push('');
    }
    if (step.notes) {
      lines.push(`**Notes:** ${step.notes}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  if (r.comments) {
    lines.push('## Comments');
    lines.push('');
    lines.push(r.comments);
    lines.push('');
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
    session_name?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDir();
  const report_id = `${args.scenario_id}_${Date.now()}`;
  const report: TsdReport = {
    report_id,
    scenario_id: args.scenario_id,
    scenario_title: args.scenario_title,
    severity: args.severity ?? null,
    user_role: args.user_role ?? null,
    session_name: args.session_name ?? null,
    started_at: new Date().toISOString(),
    finished_at: null,
    overall_result: null,
    comments: null,
    steps: [],
  };
  await saveReport(report);
  return {
    report_id,
    reports_dir: REPORTS_DIR,
    hint: `Use report_id "${report_id}" in all subsequent record_step and finish_report calls`,
  };
}

// ── record_step ───────────────────────────────────────────────────────────────

export async function record_step(
  args: {
    report_id: string;
    step_number: number;
    description: string;
    expected?: string;
    passed: boolean | null;
    actual?: string;
    screenshot_filename?: string;
    notes?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  const report = await readReport(args.report_id);

  // Replace if step already recorded (allow re-recording a step)
  const existing = report.steps.findIndex(s => s.step_number === args.step_number);
  const step: StepRecord = {
    step_number: args.step_number,
    description: args.description,
    expected: args.expected ?? null,
    passed: args.passed,
    actual: args.actual ?? null,
    screenshot_filename: args.screenshot_filename ?? null,
    notes: args.notes ?? null,
    recorded_at: new Date().toISOString(),
  };

  if (existing >= 0) {
    report.steps[existing] = step;
  } else {
    report.steps.push(step);
    report.steps.sort((a, b) => a.step_number - b.step_number);
  }

  await saveReport(report);

  const passed_count  = report.steps.filter(s => s.passed === true).length;
  const failed_count  = report.steps.filter(s => s.passed === false).length;
  const skipped_count = report.steps.filter(s => s.passed === null).length;

  return {
    report_id: args.report_id,
    step_number: args.step_number,
    passed: args.passed,
    steps_recorded: report.steps.length,
    passed_count,
    failed_count,
    skipped_count,
  };
}

// ── finish_report ─────────────────────────────────────────────────────────────

export async function finish_report(
  args: {
    report_id: string;
    overall_result?: string;
    comments?: string;
    date_tested?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  const report = await readReport(args.report_id);

  report.finished_at = args.date_tested
    ? new Date(args.date_tested).toISOString()
    : new Date().toISOString();
  report.overall_result = args.overall_result ?? (
    report.steps.every(s => s.passed === true) ? 'PASS' : 'FAIL'
  );
  report.comments = args.comments ?? null;

  await saveReport(report);

  const md = formatReport(report);
  await writeFile(mdPath(report.report_id), md, 'utf8');

  // Send report to webchat
  const ctx = _ctx as SkillContext;
  if (ctx?.channel?.send && ctx?.node_id) {
    await ctx.channel.send(ctx.node_id, md).catch(() => {});
  }

  const passed_count  = report.steps.filter(s => s.passed === true).length;
  const failed_count  = report.steps.filter(s => s.passed === false).length;
  const skipped_count = report.steps.filter(s => s.passed === null).length;

  return {
    report_id: report.report_id,
    scenario_id: report.scenario_id,
    overall_result: report.overall_result,
    steps_total: report.steps.length,
    passed_count,
    failed_count,
    skipped_count,
    sent_to_chat: !!(ctx?.channel?.send),
    md_file: mdPath(report.report_id),
  };
}

// ── get_report ────────────────────────────────────────────────────────────────

export async function get_report(
  args: { report_id: string },
  _ctx: unknown,
): Promise<unknown> {
  const report = await readReport(args.report_id);
  const md = formatReport(report);

  const passed_count  = report.steps.filter(s => s.passed === true).length;
  const failed_count  = report.steps.filter(s => s.passed === false).length;
  const skipped_count = report.steps.filter(s => s.passed === null).length;

  return {
    report,
    summary: {
      passed_count,
      failed_count,
      skipped_count,
      total: report.steps.length,
      overall_result: report.overall_result,
      finished: !!report.finished_at,
    },
    formatted_preview: md,
  };
}

// ── list_reports ──────────────────────────────────────────────────────────────

export async function list_reports(
  args: { scenario_id?: string },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDir();
  let files: string[];
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    return [];
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  const reports: unknown[] = [];

  for (const file of jsonFiles) {
    try {
      const r: TsdReport = JSON.parse(await readFile(join(REPORTS_DIR, file), 'utf8'));
      if (args.scenario_id && r.scenario_id !== args.scenario_id) continue;
      reports.push({
        report_id: r.report_id,
        scenario_id: r.scenario_id,
        scenario_title: r.scenario_title,
        severity: r.severity,
        user_role: r.user_role,
        started_at: r.started_at,
        finished_at: r.finished_at,
        overall_result: r.overall_result,
        steps_count: r.steps.length,
        passed_count: r.steps.filter(s => s.passed === true).length,
        failed_count: r.steps.filter(s => s.passed === false).length,
      });
    } catch { /* skip corrupt files */ }
  }

  // Sort newest first
  (reports as { started_at: string }[]).sort((a, b) =>
    b.started_at.localeCompare(a.started_at)
  );

  return reports;
}

// ── send_report ───────────────────────────────────────────────────────────────

export async function send_report(
  args: { report_id: string; screenshots?: 'all' | 'failed' | 'none' },
  _ctx: unknown,
): Promise<unknown> {
  const report = await readReport(args.report_id);
  const md = formatReport(report);
  const screenshotsMode = args.screenshots ?? 'all';

  const ctx = _ctx as SkillContext;
  if (!ctx?.channel?.send || !ctx?.node_id) {
    return { error: 'No channel context — cannot send to webchat', report_id: args.report_id };
  }

  // Send text report first
  await ctx.channel.send(ctx.node_id, md).catch(() => {});

  // Send screenshots
  let screenshotsSent = 0;
  if (screenshotsMode !== 'none') {
    for (const step of report.steps) {
      if (!step.screenshot_filename) continue;
      if (screenshotsMode === 'failed' && step.passed !== false) continue;

      const filepath = join(REPORTS_DIR.replace('/tsd_reports', ''), step.screenshot_filename);
      if (!existsSync(filepath)) continue;

      const caption = `Step ${step.step_number} — ${stepIcon(step.passed)}${step.description ? ': ' + step.description.slice(0, 80) : ''}`;
      await ctx.channel.send(ctx.node_id, undefined, [{
        type: 'photo',
        url: `/uploads/${step.screenshot_filename}`,
        caption,
        filename: step.screenshot_filename,
      }]).catch(() => {});
      screenshotsSent++;
    }
  }

  return {
    sent: true,
    report_id: args.report_id,
    scenario_id: report.scenario_id,
    overall_result: report.overall_result,
    text_sent: true,
    screenshots_sent: screenshotsSent,
    screenshots_mode: screenshotsMode,
  };
}
