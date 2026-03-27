/**
 * playwright_runner skill
 * Runs a full TSD test scenario in a single tool call.
 * All steps share one browser session — login once, execute all steps,
 * get per-step results + screenshots back atomically.
 */

import { chromium, Page, BrowserContext } from 'playwright';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const WORKSPACE   = '/root/.aura/workspace';
const REPORTS_DIR = '/root/.aura/workspace/tsd_reports';
const CHROMIUM_BIN = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium';
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

// ── Assertion helper (same pattern as playwright_testing.ts) ──────────────────

interface AssertResult {
  name: string;
  passed: boolean;
  actual?: string;
}

function makeAssert(results: AssertResult[]) {
  return function assert(condition: boolean, name: string, actual?: string): void {
    results.push({ name, passed: !!condition, actual });
    if (!condition) throw new Error(`Assertion failed: ${name}${actual ? ` (actual: ${actual})` : ''}`);
  };
}

// ── Session helpers ───────────────────────────────────────────────────────────

function sessionFile(name: string): string {
  return join(WORKSPACE, `pw_session_${name}.json`);
}

async function ensureDirs(): Promise<void> {
  for (const d of [WORKSPACE, REPORTS_DIR]) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }
}

// ── Selector auto-detection (same candidates as playwright_testing.ts) ────────

const USERNAME_CANDIDATES = [
  'input[type=email]', 'input[name=email]', 'input[name=username]',
  'input[name=user]', 'input[name=login]', 'input[id*=email i]',
  'input[id*=username i]', 'input[id*=user i]', 'input[placeholder*=email i]',
  'input[placeholder*=username i]', 'input[placeholder*=user i]', 'input[type=text]',
];
const PASSWORD_CANDIDATES = ['input[type=password]'];
const SUBMIT_CANDIDATES   = [
  'button[type=submit]', 'input[type=submit]',
  'button:has-text("Log in")', 'button:has-text("Login")',
  'button:has-text("Sign in")', 'button:has-text("Sign In")',
  'button:has-text("Continue")', 'button:has-text("Next")', 'button',
];

async function resolveSelector(page: Page, candidates: string[], explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const sel of candidates) {
    try { if (await page.locator(sel).count() > 0) return sel; } catch { /* try next */ }
  }
  throw new Error(`Could not auto-detect selector. Tried: ${candidates.slice(0, 5).join(', ')}...`);
}

// ── tsd_runner JSON helpers ───────────────────────────────────────────────────

interface TsdStepRecord {
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
  steps: TsdStepRecord[];
  [key: string]: unknown;
}

async function appendToReport(reportId: string, step: TsdStepRecord): Promise<void> {
  const p = join(REPORTS_DIR, `${reportId}.json`);
  if (!existsSync(p)) return; // report not found — skip silently
  try {
    const report = JSON.parse(await readFile(p, 'utf8')) as TsdReport;
    const existing = report.steps.findIndex(s => s.step_number === step.step_number);
    if (existing >= 0) report.steps[existing] = step;
    else { report.steps.push(step); report.steps.sort((a, b) => a.step_number - b.step_number); }
    await writeFile(p, JSON.stringify(report, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

// ── run_test_scenario ─────────────────────────────────────────────────────────

interface TestStep {
  name: string;
  description: string;
  expected?: string;
  script: string;
  url?: string;
}

interface LoginArgs {
  username: string;
  password: string;
  username_selector?: string;
  password_selector?: string;
  submit_selector?: string;
  success_url_contains?: string;
}

interface StepResult {
  step_number: number;
  name: string;
  description: string;
  expected: string | null;
  passed: boolean;
  assertions: AssertResult[];
  screenshot_filename: string | null;
  error: string | null;
  duration_ms: number;
}

export async function run_test_scenario(
  args: {
    url: string;
    session_name?: string;
    login?: LoginArgs;
    steps: TestStep[];
    start_step_number?: number;
    screenshot_each_step?: boolean;
    report_id?: string;
    continue_on_failure?: boolean;
  },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDirs();

  const sessionName      = args.session_name ?? `scenario_${Date.now()}`;
  const screenshotEach   = args.screenshot_each_step !== false;
  const continueOnFail   = args.continue_on_failure !== false;
  const sessionPath      = sessionFile(sessionName);
  const startMs          = Date.now();
  const stepResults: StepResult[] = [];
  let loginError: string | null = null;
  let browser;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, executablePath: CHROMIUM_BIN });
    const ctxOpts = existsSync(sessionPath) ? { storageState: sessionPath as string } : {};
    context = await browser.newContext({
      ...ctxOpts,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // Navigate to starting URL
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Login if credentials provided
    if (args.login) {
      try {
        const l = args.login;
        const userSel   = await resolveSelector(page, USERNAME_CANDIDATES, l.username_selector);
        const passSel   = await resolveSelector(page, PASSWORD_CANDIDATES, l.password_selector);
        const submitSel = await resolveSelector(page, SUBMIT_CANDIDATES,   l.submit_selector);

        await page.locator(userSel).fill(l.username);
        await page.locator(passSel).fill(l.password);
        await page.locator(submitSel).click();

        if (l.success_url_contains) {
          await page.waitForURL(`**${l.success_url_contains}**`, { timeout: 20_000 });
        } else {
          await page.waitForNavigation({ timeout: 20_000 }).catch(() => {});
        }
      } catch (err) {
        loginError = err instanceof Error ? err.message : String(err);
      }
    }

    // Execute steps
    const stepOffset = (args.start_step_number ?? 1) - 1;
    for (let i = 0; i < args.steps.length; i++) {
      const step      = args.steps[i];
      const stepNum   = stepOffset + i + 1;
      const stepStart = Date.now();
      const assertions: AssertResult[] = [];
      let passed = false;
      let errorMsg: string | null = null;
      let screenshotFile: string | null = null;

      try {
        // Navigate if step has its own URL
        if (step.url) {
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        }

        // Execute step script
        const assert = makeAssert(assertions);
        const fn = new Function('page', 'assert', `return (async () => { ${step.script} })();`);
        await fn(page, assert);
        passed = true;
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        passed   = false;
      }

      // Screenshot after every step
      if (screenshotEach || !passed) {
        try {
          const slug = `${sessionName}_step${stepNum}_${Date.now()}`;
          const filename = `${slug}.png`;
          await page.screenshot({ path: join(WORKSPACE, filename), fullPage: false });
          screenshotFile = filename;
        } catch { /* screenshot non-fatal */ }
      }

      const result: StepResult = {
        step_number:       stepNum,
        name:              step.name,
        description:       step.description,
        expected:          step.expected ?? null,
        passed,
        assertions,
        screenshot_filename: screenshotFile,
        error:             errorMsg,
        duration_ms:       Date.now() - stepStart,
      };
      stepResults.push(result);

      // Auto-record to tsd_runner report if report_id given
      if (args.report_id) {
        await appendToReport(args.report_id, {
          step_number:         stepNum,
          description:         step.description,
          expected:            step.expected ?? null,
          passed,
          actual:              errorMsg ?? (assertions.length > 0 ? `${assertions.filter(a => a.passed).length}/${assertions.length} assertions passed` : 'Script completed'),
          screenshot_filename: screenshotFile,
          notes:               errorMsg ? `Error: ${errorMsg}` : null,
          recorded_at:         new Date().toISOString(),
        });
      }

      if (!passed && !continueOnFail) break;
    }

    // Save session
    await context.storageState({ path: sessionPath }).catch(() => {});

  } finally {
    await context?.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  const passedCount = stepResults.filter(s => s.passed).length;
  const overallPassed = !loginError && passedCount === stepResults.length;

  return {
    overall_passed:   overallPassed,
    session_name:     sessionName,
    login_error:      loginError,
    steps_total:      stepResults.length,
    steps_passed:     passedCount,
    steps_failed:     stepResults.length - passedCount,
    duration_ms:      Date.now() - startMs,
    steps:            stepResults,
    report_id:        args.report_id ?? null,
    next_step:        args.report_id
      ? `Call tsd_runner.finish_report with report_id: "${args.report_id}" to send the report to webchat`
      : undefined,
  };
}
