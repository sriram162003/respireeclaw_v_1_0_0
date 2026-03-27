/**
 * playwright_testing skill
 * Reliable browser-based UI testing using Playwright with session persistence.
 * Sessions are saved as storageState (cookies + localStorage) and reused across calls.
 */

import { chromium, Page, BrowserContext } from 'playwright';
import { existsSync, unlinkSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const SESSION_DIR = '/root/.aura/workspace';
const SCREENSHOTS_DIR = '/root/.aura/workspace';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

// ── Session helpers ────────────────────────────────────────────────────────────

function sessionFile(name: string): string {
  return join(SESSION_DIR, `pw_session_${name}.json`);
}

async function ensureDir(): Promise<void> {
  if (!existsSync(SESSION_DIR)) await mkdir(SESSION_DIR, { recursive: true });
}

// ── Browser/page factory ───────────────────────────────────────────────────────

async function withPage<T>(
  url: string,
  sessionName: string | undefined,
  fn: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  await ensureDir();
  const browser = await chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
    executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium',
  });

  const sessionPath = sessionName ? sessionFile(sessionName) : undefined;
  const contextOpts = sessionPath && existsSync(sessionPath)
    ? { storageState: sessionPath as string }
    : {};

  const context = await browser.newContext({
    ...contextOpts,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await fn(page, context);
  } finally {
    if (sessionPath) {
      await context.storageState({ path: sessionPath }).catch(() => {});
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Screenshot helper ──────────────────────────────────────────────────────────

async function screenshotOnFailure(page: Page, label: string): Promise<string | undefined> {
  try {
    const slug = label.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const filename = `fail_${slug}_${Date.now()}.png`;
    const path = join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path, fullPage: false });
    return filename;
  } catch {
    return undefined;
  }
}

// ── Retry wrapper ──────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ── Assertion helper ───────────────────────────────────────────────────────────

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

// ── inspect_page ──────────────────────────────────────────────────────────────

export async function inspect_page(
  args: {
    url: string;
    session_name?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  const startMs = Date.now();
  let errorMessage: string | undefined;
  let result: unknown;

  try {
    await withPage(args.url, args.session_name, async (page) => {
      await page.waitForLoadState('domcontentloaded');

      const data = await page.evaluate(() => {
        // Collect all input fields
        const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => {
          const e = el as HTMLInputElement;
          const id = e.id ? `#${e.id}` : null;
          const nameAttr = e.name ? `[name="${e.name}"]` : null;
          const typeAttr = e.type ? `[type="${e.type}"]` : null;
          const placeholder = e.placeholder || null;
          const label = e.id
            ? (document.querySelector(`label[for="${e.id}"]`) as HTMLElement | null)?.innerText?.trim() || null
            : null;
          return {
            tag: e.tagName.toLowerCase(),
            type: e.type || null,
            id: e.id || null,
            name: e.name || null,
            placeholder,
            label,
            selector: id || (e.name ? `${e.tagName.toLowerCase()}[name="${e.name}"]` : null) || (typeAttr ? `${e.tagName.toLowerCase()}${typeAttr}` : e.tagName.toLowerCase()),
            visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
          };
        });

        // Collect buttons and submit inputs
        const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]')).map((el) => {
          const e = el as HTMLElement;
          const id = e.id ? `#${e.id}` : null;
          const text = e.textContent?.trim() || (e as HTMLInputElement).value || null;
          const type = (e as HTMLInputElement).type || e.tagName.toLowerCase();
          return {
            tag: e.tagName.toLowerCase(),
            type,
            id: e.id || null,
            text,
            selector: id || (text ? `${e.tagName.toLowerCase()}:has-text("${text?.slice(0, 30)}")` : e.tagName.toLowerCase()),
            visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
          };
        });

        // Collect forms
        const forms = Array.from(document.querySelectorAll('form')).map((form, i) => ({
          index: i,
          id: form.id || null,
          action: form.action || null,
          method: form.method || null,
          selector: form.id ? `#${form.id}` : `form:nth-of-type(${i + 1})`,
        }));

        return { inputs, buttons, forms, title: document.title, url: window.location.href };
      });

      result = {
        url: page.url(),
        title: (data as { title: string }).title,
        forms: (data as { forms: unknown[] }).forms,
        inputs: (data as { inputs: unknown[] }).inputs,
        buttons: (data as { buttons: unknown[] }).buttons,
        duration_ms: Date.now() - startMs,
        hint: 'Use the selectors from inputs/buttons above to call login or fill_form',
      };
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  return result ?? { error: errorMessage, url: args.url, duration_ms: Date.now() - startMs };
}

// ── login ─────────────────────────────────────────────────────────────────────

// Common selector candidates tried in order when explicit selectors are not given
const USERNAME_CANDIDATES = [
  'input[type=email]',
  'input[name=email]',
  'input[name=username]',
  'input[name=user]',
  'input[name=login]',
  'input[id*=email i]',
  'input[id*=username i]',
  'input[id*=user i]',
  'input[placeholder*=email i]',
  'input[placeholder*=username i]',
  'input[placeholder*=user i]',
  'input[type=text]',
];

const PASSWORD_CANDIDATES = [
  'input[type=password]',
];

const SUBMIT_CANDIDATES = [
  'button[type=submit]',
  'input[type=submit]',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
  'button',
];

async function resolveSelector(page: Page, candidates: string[], explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const sel of candidates) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) return sel;
    } catch { /* try next */ }
  }
  throw new Error(`Could not auto-detect selector. Tried: ${candidates.join(', ')}. Call inspect_page first to find the correct selector.`);
}

export async function login(
  args: {
    url: string;
    username_selector?: string;
    username_value: string;
    password_selector?: string;
    password_value: string;
    submit_selector?: string;
    success_url_contains?: string;
    session_name?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  const sessionName = args.session_name ?? 'default';
  const startMs = Date.now();
  let final_url: string | undefined;
  let title: string | undefined;
  let screenshot: string | undefined;
  let errorMessage: string | undefined;
  let success = false;
  let resolved_selectors: { username?: string; password?: string; submit?: string } = {};

  try {
    await withRetry(async () => {
      await withPage(args.url, sessionName, async (page, _ctx2) => {
        const userSel = await resolveSelector(page, USERNAME_CANDIDATES, args.username_selector);
        const passSel = await resolveSelector(page, PASSWORD_CANDIDATES, args.password_selector);
        const submitSel = await resolveSelector(page, SUBMIT_CANDIDATES, args.submit_selector);
        resolved_selectors = { username: userSel, password: passSel, submit: submitSel };

        await page.locator(userSel).fill(args.username_value);
        await page.locator(passSel).fill(args.password_value);
        await page.locator(submitSel).click();

        if (args.success_url_contains) {
          await page.waitForURL(`**${args.success_url_contains}**`, { timeout: 15_000 });
        } else {
          // Wait for navigation away from the login page
          await page.waitForNavigation({ timeout: 15_000 }).catch(() => {});
        }

        final_url = page.url();
        title = await page.title();
        success = true;
      });
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    // Try to get a screenshot even on failure — need a fresh page
    try {
      const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium' });
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx2.newPage();
      await page.goto(args.url, { timeout: 15_000 });
      screenshot = await screenshotOnFailure(page, `login_${sessionName}`);
      await ctx2.close();
      await browser.close();
    } catch { /* screenshot is optional */ }
  }

  return {
    success,
    session_name: sessionName,
    final_url,
    title,
    resolved_selectors,
    screenshot_on_failure: screenshot,
    duration_ms: Date.now() - startMs,
    error: errorMessage,
    next_step: success
      ? undefined
      : (screenshot
          ? `Call send_file with filename: "${screenshot}" to show failure screenshot`
          : `Call inspect_page with url: "${args.url}" to discover the correct CSS selectors for the login form, then retry login with explicit selectors`),
  };
}

// ── run_script ────────────────────────────────────────────────────────────────

export async function run_script(
  args: {
    url: string;
    script: string;
    session_name?: string;
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const timeoutMs = args.timeout_ms ?? 30_000;
  const assertions: AssertResult[] = [];
  const startMs = Date.now();
  let passed = false;
  let errorMessage: string | undefined;
  let screenshot: string | undefined;

  try {
    await withPage(args.url, args.session_name, async (page) => {
      page.setDefaultTimeout(timeoutMs);
      const assert = makeAssert(assertions);

      // Provide: page, assert — agent writes Playwright API calls directly
      const fn = new Function(
        'page', 'assert',
        `return (async () => { ${args.script} })();`,
      );

      await fn(page, assert);
      passed = true;
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    // Screenshot on failure using a fresh page if session not available
    try {
      const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium' });
      const sessionPath = args.session_name ? sessionFile(args.session_name) : undefined;
      const ctxOpts = sessionPath && existsSync(sessionPath) ? { storageState: sessionPath } : {};
      const ctx2 = await browser.newContext({ ...ctxOpts, viewport: { width: 1280, height: 800 } });
      const page = await ctx2.newPage();
      await page.goto(args.url, { timeout: 15_000 }).catch(() => {});
      screenshot = await screenshotOnFailure(page, `script_${args.url.replace(/\W/g, '_').slice(0, 30)}`);
      await ctx2.close();
      await browser.close();
    } catch { /* optional */ }
  }

  return {
    passed,
    assertions,
    passed_count: assertions.filter(a => a.passed).length,
    total_count: assertions.length,
    duration_ms: Date.now() - startMs,
    url: args.url,
    error: errorMessage,
    screenshot_on_failure: screenshot,
    next_step: screenshot ? `Call send_file with filename: "${screenshot}" to show failure screenshot` : undefined,
  };
}

// ── fill_form ─────────────────────────────────────────────────────────────────

export async function fill_form(
  args: {
    url: string;
    fields: Array<{ selector: string; value: string; clear_first?: boolean }>;
    submit_selector?: string;
    wait_after_ms?: number;
    session_name?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  const waitAfterMs = args.wait_after_ms ?? 2000;
  const startMs = Date.now();
  const steps: Array<{ selector: string; status: 'ok' | 'error'; detail?: string }> = [];
  let passed = false;
  let result_url: string | undefined;
  let result_title: string | undefined;
  let errorMessage: string | undefined;
  let screenshot: string | undefined;

  try {
    await withRetry(async () => {
      await withPage(args.url, args.session_name, async (page) => {
        for (const field of args.fields) {
          try {
            const locator = page.locator(field.selector);
            await locator.waitFor({ state: 'visible', timeout: 10_000 });
            if (field.clear_first !== false) await locator.clear();
            await locator.fill(field.value);
            steps.push({ selector: field.selector, status: 'ok' });
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            steps.push({ selector: field.selector, status: 'error', detail });
            throw err;
          }
        }

        if (args.submit_selector) {
          const submitLocator = page.locator(args.submit_selector);
          await submitLocator.waitFor({ state: 'visible', timeout: 10_000 });
          await submitLocator.click();
          await page.waitForTimeout(waitAfterMs);
        }

        result_url = page.url();
        result_title = await page.title();
        passed = true;
      });
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    try {
      const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium' });
      const sessionPath = args.session_name ? sessionFile(args.session_name) : undefined;
      const ctxOpts = sessionPath && existsSync(sessionPath) ? { storageState: sessionPath } : {};
      const ctx2 = await browser.newContext({ ...ctxOpts, viewport: { width: 1280, height: 800 } });
      const page = await ctx2.newPage();
      await page.goto(args.url, { timeout: 15_000 }).catch(() => {});
      screenshot = await screenshotOnFailure(page, `fill_form_${args.url.replace(/\W/g, '_').slice(0, 30)}`);
      await ctx2.close();
      await browser.close();
    } catch { /* optional */ }
  }

  return {
    passed,
    steps,
    result_url,
    result_title,
    error: errorMessage,
    screenshot_on_failure: screenshot,
    duration_ms: Date.now() - startMs,
    url: args.url,
    next_step: screenshot ? `Call send_file with filename: "${screenshot}" to show failure screenshot` : undefined,
  };
}

// ── assert_page ───────────────────────────────────────────────────────────────

type AssertionType = 'element_visible' | 'element_text' | 'url_contains' | 'element_absent' | 'page_title';

export async function assert_page(
  args: {
    url: string;
    session_name?: string;
    assertions: Array<{
      type: AssertionType;
      selector?: string;
      expected?: string;
      timeout_ms?: number;
    }>;
    navigate_first?: boolean;
  },
  _ctx: unknown,
): Promise<unknown> {
  const startMs = Date.now();
  const results: Array<{ type: string; selector?: string; expected?: string; passed: boolean; actual?: string; error?: string }> = [];
  let allPassed = false;
  let screenshot: string | undefined;

  try {
    await withPage(args.url, args.session_name, async (page) => {
      for (const assertion of args.assertions) {
        const timeout = assertion.timeout_ms ?? 10_000;
        let passed = false;
        let actual: string | undefined;
        let error: string | undefined;

        try {
          switch (assertion.type) {
            case 'element_visible': {
              const el = page.locator(assertion.selector!);
              await el.waitFor({ state: 'visible', timeout });
              passed = true;
              break;
            }
            case 'element_text': {
              const el = page.locator(assertion.selector!);
              await el.waitFor({ state: 'visible', timeout });
              actual = (await el.textContent() ?? '').trim();
              passed = actual.includes(assertion.expected ?? '');
              break;
            }
            case 'url_contains': {
              await page.waitForURL(`**${assertion.expected}**`, { timeout });
              actual = page.url();
              passed = true;
              break;
            }
            case 'element_absent': {
              // Wait for element to disappear (or confirm it was never there)
              try {
                await page.locator(assertion.selector!).waitFor({ state: 'detached', timeout });
              } catch {
                const count = await page.locator(assertion.selector!).count();
                if (count === 0) { passed = true; break; }
              }
              const count = await page.locator(assertion.selector!).count();
              passed = count === 0;
              actual = `${count} element(s) found`;
              break;
            }
            case 'page_title': {
              actual = await page.title();
              passed = actual.includes(assertion.expected ?? '');
              break;
            }
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          passed = false;
          // Try to grab current page state for debugging
          try { actual = page.url(); } catch { /* ignore */ }
        }

        results.push({ type: assertion.type, selector: assertion.selector, expected: assertion.expected, passed, actual, error });

        if (!passed) {
          screenshot = await screenshotOnFailure(page, `assert_${assertion.type}`);
          break; // Stop at first failure for a clear screenshot
        }
      }

      allPassed = results.every(r => r.passed);
    });
  } catch (err) {
    results.push({ type: 'navigation', passed: false, error: err instanceof Error ? err.message : String(err) });
  }

  return {
    passed: allPassed,
    results,
    passed_count: results.filter(r => r.passed).length,
    total_count: results.length,
    duration_ms: Date.now() - startMs,
    url: args.url,
    screenshot_on_failure: screenshot,
    next_step: screenshot ? `Call send_file with filename: "${screenshot}" to show what the page looked like at failure` : undefined,
  };
}

// ── take_screenshot ───────────────────────────────────────────────────────────

export async function take_screenshot(
  args: {
    url: string;
    session_name?: string;
    highlight_selector?: string;
    full_page?: boolean;
    filename?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDir();
  const startMs = Date.now();
  let saved: string | undefined;
  let filename: string | undefined;
  let title: string | undefined;
  let highlighted = false;
  let errorMessage: string | undefined;

  try {
    await withPage(args.url, args.session_name, async (page) => {
      await page.waitForLoadState('domcontentloaded');
      title = await page.title();

      if (args.highlight_selector) {
        try {
          await page.locator(args.highlight_selector).evaluate((el) => {
            (el as HTMLElement).style.outline = '3px solid red';
            (el as HTMLElement).style.outlineOffset = '2px';
          });
          highlighted = true;
        } catch { /* highlight is non-fatal */ }
      }

      const slug = args.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').slice(0, 60);
      filename = args.filename ?? `${slug}_${Date.now()}.png`;
      saved = join(SCREENSHOTS_DIR, filename);

      await page.screenshot({
        path: saved,
        fullPage: args.full_page ?? false,
      });
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  return {
    saved,
    filename,
    title,
    highlighted,
    highlight_selector: args.highlight_selector,
    full_page: args.full_page ?? false,
    error: errorMessage,
    duration_ms: Date.now() - startMs,
    url: args.url,
    next_step: filename ? `Call send_file with filename: "${filename}" to send this screenshot to the user` : undefined,
  };
}

// ── clear_session ─────────────────────────────────────────────────────────────

export async function clear_session(
  args: { session_name?: string },
  _ctx: unknown,
): Promise<unknown> {
  const sessionName = args.session_name ?? 'default';
  const path = sessionFile(sessionName);
  let cleared = false;
  if (existsSync(path)) {
    unlinkSync(path);
    cleared = true;
  }
  return { cleared, session_name: sessionName, message: cleared ? `Session "${sessionName}" cleared` : `No session file found for "${sessionName}"` };
}
