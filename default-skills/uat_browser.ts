/**
 * uat_browser skill
 * Declarative browser automation for UAT testing with persistent session pool.
 * Sessions live in module scope — open once, reuse across multiple tool calls.
 * Supports OTP flows, device selection, popup handling, and multi-step testing.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const CHROMIUM_BIN =
  process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--headless',
];

const SCREENSHOTS_DIR = '/root/.aura/workspace/screenshots';
const SESSIONS_DIR    = '/root/.aura/workspace';
const SESSION_IDLE_MS = 15 * 60 * 1000; // 15 minutes

// ── Session pool ──────────────────────────────────────────────────────────────

interface SessionEntry {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionEntry>();

function sessionStatePath(name: string): string {
  return join(SESSIONS_DIR, `session_${name}.json`);
}

function touchSession(name: string): void {
  const entry = sessions.get(name);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(async () => {
    await killSession(name);
  }, SESSION_IDLE_MS);
}

async function killSession(name: string): Promise<void> {
  const entry = sessions.get(name);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try { await entry.browser.close(); } catch { /* ignore */ }
  sessions.delete(name);
}

async function getSession(name: string): Promise<SessionEntry> {
  const entry = sessions.get(name);
  if (!entry || !entry.browser.isConnected()) {
    throw new Error(
      `No active session "${name}". Call open_browser first.`,
    );
  }
  touchSession(name);
  return entry;
}

async function ensureDirs(): Promise<void> {
  for (const d of [SCREENSHOTS_DIR, SESSIONS_DIR]) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }
}

// ── Selector resolution ───────────────────────────────────────────────────────

const USERNAME_CANDIDATES = [
  'input[type=email]',
  'input[name=email]',
  'input[name=username]',
  'input[name=user]',
  'input[name=login]',
  'input[id*=email i]',
  'input[id*=username i]',
  'input[placeholder*=email i]',
  'input[placeholder*=username i]',
  'input[type=text]',
];
const PASSWORD_CANDIDATES = ['input[type=password]'];
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

async function autoDetect(page: Page, candidates: string[], explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const sel of candidates) {
    try {
      if (await page.locator(sel).count() > 0) return sel;
    } catch { /* try next */ }
  }
  throw new Error(`Could not auto-detect selector. Tried: ${candidates.slice(0, 4).join(', ')}…`);
}

interface ResolveOpts {
  selector?: string;
  text?: string;
  role?: string;
  aria_label?: string;
  placeholder?: string;
  label?: string;
  index?: number;
}

function resolveLocator(page: Page, opts: ResolveOpts) {
  const idx = opts.index ?? 0;
  if (opts.selector)   return page.locator(opts.selector).nth(idx);
  if (opts.text)       return page.locator(`text=${opts.text}`).nth(idx);
  if (opts.role) {
    const roleOpts = opts.text ? { name: opts.text } : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return page.getByRole(opts.role as any, roleOpts).nth(idx);
  }
  if (opts.aria_label) return page.locator(`[aria-label="${opts.aria_label}"]`).nth(idx);
  if (opts.placeholder) return page.locator(`[placeholder*="${opts.placeholder}" i]`).nth(idx);
  if (opts.label) {
    // Try several label association patterns
    return page.locator(
      `label:has-text("${opts.label}") ~ input, ` +
      `label:has-text("${opts.label}") + input, ` +
      `label:has-text("${opts.label}") ~ textarea, ` +
      `label:has-text("${opts.label}") + textarea`,
    ).nth(idx);
  }
  throw new Error(
    'Provide at least one of: selector, text, role, aria_label, placeholder, label',
  );
}

// ── Popup / modal detection helpers ──────────────────────────────────────────

const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '.modal',
  '.popup',
  '.drawer',
  '[class*="modal" i]:not(body)',
  '[class*="dialog" i]:not(body)',
  '[class*="overlay" i]:not(body)',
];

const TOAST_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '.toast',
  '.notification',
  '[class*="toast" i]',
  '[class*="snackbar" i]',
  '[class*="alert" i]:not(.alert-label)',
];

// ── open_browser ──────────────────────────────────────────────────────────────

export async function open_browser(
  args: {
    session_name: string;
    url?: string;
    width?: number;
    height?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  await ensureDirs();
  await killSession(args.session_name); // Close any existing session with this name

  const statePath = sessionStatePath(args.session_name);
  const contextOpts = existsSync(statePath)
    ? { storageState: statePath }
    : {};

  const browser = await chromium.launch({
    executablePath: CHROMIUM_BIN,
    args: LAUNCH_ARGS,
  });

  const context = await browser.newContext({
    ...contextOpts,
    viewport: {
      width: args.width ?? 1280,
      height: args.height ?? 800,
    },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  const entry: SessionEntry = { browser, context, page, idleTimer: null };
  sessions.set(args.session_name, entry);
  touchSession(args.session_name);

  let url = 'about:blank';
  let title = '';
  if (args.url) {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    url = page.url();
    title = await page.title();
  }

  return {
    session_name: args.session_name,
    url,
    title,
    session_restored: existsSync(statePath),
  };
}

// ── navigate ──────────────────────────────────────────────────────────────────

export async function navigate(
  args: {
    session_name: string;
    url: string;
    wait_until?: 'domcontentloaded' | 'networkidle' | 'load';
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);
  await page.goto(args.url, {
    waitUntil: args.wait_until ?? 'domcontentloaded',
    timeout: 30_000,
  });
  return { url: page.url(), title: await page.title() };
}

// ── login ─────────────────────────────────────────────────────────────────────

export async function login(
  args: {
    session_name: string;
    username: string;
    password: string;
    username_selector?: string;
    password_selector?: string;
    submit_selector?: string;
    success_url?: string;
    throw_on_error?: boolean;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page, context } = await getSession(args.session_name);

  try {
    const userSel   = await autoDetect(page, USERNAME_CANDIDATES, args.username_selector);
    const passSel   = await autoDetect(page, PASSWORD_CANDIDATES, args.password_selector);
    const submitSel = await autoDetect(page, SUBMIT_CANDIDATES,   args.submit_selector);

    await page.locator(userSel).fill(args.username);
    await page.locator(passSel).fill(args.password);
    await page.locator(submitSel).click();

    if (args.success_url) {
      await page.waitForURL(`**${args.success_url}**`, { timeout: 20_000 });
    } else {
      await page.waitForNavigation({ timeout: 20_000 }).catch(() => {});
    }

    // Save session state for reuse
    await ensureDirs();
    await context.storageState({ path: sessionStatePath(args.session_name) });

    return { success: true, url: page.url() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (args.throw_on_error) throw new Error(`login failed: ${error}`);
    return { success: false, url: page.url(), error };
  }
}

// ── snapshot ──────────────────────────────────────────────────────────────────

export async function snapshot(
  args: { session_name: string },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  // Wait for any pending JS to settle
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Use string-based evaluate to prevent esbuild from injecting __name() helpers
  // into the function body — __name is a module-scope esbuild helper and is not
  // available inside the browser sandbox that page.evaluate runs in.
  const script = `
    (() => {
      const modalSels = ${JSON.stringify(MODAL_SELECTORS)};
      const toastSels = ${JSON.stringify(TOAST_SELECTORS)};

      function isVis(el) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.offsetParent !== null;
      }
      function selFor(el) {
        if (el.id) return '#' + el.id;
        if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
        const cls = Array.from(el.classList).filter(c => !/^(ng-|_|js-|svelte-)/.test(c)).slice(0, 2).join('.');
        return cls ? el.tagName.toLowerCase() + '.' + cls : el.tagName.toLowerCase();
      }
      function lblFor(el) {
        if (el.id) {
          const lbl = document.querySelector('label[for="' + el.id + '"]');
          if (lbl) return lbl.innerText.trim().slice(0, 80);
        }
        const parent = el.closest('label');
        return parent ? parent.innerText.trim().slice(0, 80) : null;
      }

      const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea'))
        .filter(el => isVis(el))
        .map(el => ({ selector: selFor(el), type: el.type || 'text', placeholder: el.placeholder || null, label: lblFor(el), value: el.value || null }))
        .slice(0, 30);

      const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]'))
        .filter(el => isVis(el) && (el.innerText || el.value || '').trim())
        .map(el => ({ selector: selFor(el), text: (el.innerText || el.value || '').trim().slice(0, 80), type: el.type || null }))
        .slice(0, 40);

      const selects = Array.from(document.querySelectorAll('select'))
        .filter(el => isVis(el))
        .map(el => ({ selector: selFor(el), label: lblFor(el), selected: el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : null, options: Array.from(el.options).map(o => ({ value: o.value, text: o.text })).slice(0, 50) }))
        .slice(0, 10);

      const checkboxes = Array.from(document.querySelectorAll('input[type=checkbox], input[type=radio]'))
        .filter(el => isVis(el))
        .map(el => ({ selector: selFor(el), type: el.type, label: lblFor(el), checked: el.checked }))
        .slice(0, 20);

      const modals = [];
      for (const sel of modalSels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVis(el)) continue;
          const titleEl = el.querySelector('[class*="title" i], [class*="header" i], h1, h2, h3, h4');
          const btns = Array.from(el.querySelectorAll('button, [role=button]')).filter(b => isVis(b)).map(b => ({ text: b.innerText.trim().slice(0, 60), selector: selFor(b) })).filter(b => b.text).slice(0, 8);
          modals.push({ selector: selFor(el), role: el.getAttribute('role'), title: titleEl ? titleEl.innerText.trim().slice(0, 120) : null, text: el.innerText.trim().slice(0, 500), buttons: btns });
          if (modals.length >= 5) break;
        }
        if (modals.length >= 5) break;
      }

      const toasts = [];
      for (const sel of toastSels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVis(el)) continue;
          toasts.push({ text: el.innerText.trim().slice(0, 200), selector: selFor(el) });
          if (toasts.length >= 5) break;
        }
        if (toasts.length >= 5) break;
      }

      const tables = Array.from(document.querySelectorAll('table')).slice(0, 3).map(t => {
        const headers = Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim());
        const rows = Array.from(t.querySelectorAll('tr')).slice(1, 11)
          .map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim().slice(0, 60)))
          .filter(r => r.length > 0);
        return { headers, rows };
      });

      const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('#content') || document.body;
      const textPreview = main ? main.innerText.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2000) : '';

      return { inputs, buttons, selects, checkboxes, modals, toasts, tables, textPreview };
    })()
  `;

  const data = await page.evaluate(script) as object;

  return {
    url: page.url(),
    title: await page.title(),
    ...data,
  };
}

// ── click ─────────────────────────────────────────────────────────────────────

export async function click(
  args: {
    session_name: string;
    selector?: string;
    text?: string;
    role?: string;
    aria_label?: string;
    index?: number;
    timeout_ms?: number;
    throw_on_error?: boolean;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    const loc = resolveLocator(page, args);
    await loc.waitFor({ state: 'visible', timeout: args.timeout_ms ?? 10_000 });
    await loc.click();
    await page.waitForTimeout(300);
    return { clicked: true, url: page.url() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (args.throw_on_error) throw new Error(`click failed: ${error}`);
    return { clicked: false, url: page.url(), error };
  }
}

// ── fill ──────────────────────────────────────────────────────────────────────

export async function fill(
  args: {
    session_name: string;
    value: string;
    selector?: string;
    placeholder?: string;
    label?: string;
    index?: number;
    clear_first?: boolean;
    timeout_ms?: number;
    throw_on_error?: boolean;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    const loc = resolveLocator(page, args);
    await loc.waitFor({ state: 'visible', timeout: args.timeout_ms ?? 10_000 });
    if (args.clear_first !== false) {
      await loc.clear();
    }
    await loc.fill(args.value);
    return { filled: true, value: args.value };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (args.throw_on_error) throw new Error(`fill failed: ${error}`);
    return { filled: false, error };
  }
}

// ── select_option ─────────────────────────────────────────────────────────────

export async function select_option(
  args: {
    session_name: string;
    option_text?: string;
    option_value?: string;
    option_index?: number;
    selector?: string;
    label?: string;
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    // Try native <select> first
    const nativeSel = args.selector ?? (args.label
      ? `label:has-text("${args.label}") ~ select, label:has-text("${args.label}") + select`
      : 'select');

    const nativeCount = await page.locator(nativeSel).count();
    if (nativeCount > 0) {
      const target = args.option_value
        ? { value: args.option_value }
        : args.option_text
          ? { label: args.option_text }
          : { index: args.option_index ?? 0 };
      await page.locator(nativeSel).nth(0).selectOption(target, {
        timeout: args.timeout_ms ?? 10_000,
      });
      return { selected: true, type: 'native', option: args.option_text ?? args.option_value ?? args.option_index };
    }

    // Custom dropdown — click trigger, then click option text
    const trigger = args.selector
      ? page.locator(args.selector)
      : args.label
        ? page.locator(`[aria-label*="${args.label}" i], label:has-text("${args.label}") ~ div`)
        : page.locator('[role=combobox], [role=listbox], .select, .dropdown-toggle').nth(0);

    await trigger.click({ timeout: args.timeout_ms ?? 10_000 });
    await page.waitForTimeout(400);

    const optText = args.option_text;
    if (optText) {
      await page.locator(`li:has-text("${optText}"), [role=option]:has-text("${optText}"), .option:has-text("${optText}")`).first().click({ timeout: 5_000 });
    }

    return { selected: true, type: 'custom', option: optText };
  } catch (err) {
    return {
      selected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── check ─────────────────────────────────────────────────────────────────────

export async function check(
  args: {
    session_name: string;
    checked: boolean;
    selector?: string;
    label?: string;
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    const loc = args.selector
      ? page.locator(args.selector)
      : args.label
        ? page.locator(`label:has-text("${args.label}") input[type=checkbox], label:has-text("${args.label}") input[type=radio]`)
        : page.locator('input[type=checkbox]').nth(0);

    await loc.waitFor({ state: 'visible', timeout: args.timeout_ms ?? 10_000 });
    if (args.checked) {
      await loc.check();
    } else {
      await loc.uncheck();
    }
    return { state: args.checked };
  } catch (err) {
    return {
      state: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── keyboard ──────────────────────────────────────────────────────────────────

export async function keyboard(
  args: {
    session_name: string;
    key?: string;
    type_text?: string;
    selector?: string;
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    if (args.selector) {
      await page.locator(args.selector).waitFor({
        state: 'visible',
        timeout: args.timeout_ms ?? 10_000,
      });
      await page.locator(args.selector).click();
    }
    if (args.key) {
      await page.keyboard.press(args.key);
    }
    if (args.type_text) {
      await page.keyboard.type(args.type_text);
    }
    return { done: true };
  } catch (err) {
    return { done: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── wait_for ──────────────────────────────────────────────────────────────────

export async function wait_for(
  args: {
    session_name: string;
    type: 'element_visible' | 'element_hidden' | 'text_on_page' | 'url_contains' | 'network_idle' | 'timeout';
    value?: string;
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);
  const timeout = args.timeout_ms ?? 15_000;
  const start = Date.now();

  try {
    switch (args.type) {
      case 'element_visible':
        await page.locator(args.value!).waitFor({ state: 'visible', timeout });
        break;
      case 'element_hidden':
        await page.locator(args.value!).waitFor({ state: 'hidden', timeout });
        break;
      case 'text_on_page':
        await page.waitForFunction(
          (text: string) => document.body?.innerText?.includes(text),
          args.value!,
          { timeout },
        );
        break;
      case 'url_contains':
        await page.waitForURL(`**${args.value!}**`, { timeout });
        break;
      case 'network_idle':
        await page.waitForLoadState('networkidle', { timeout });
        break;
      case 'timeout':
        await page.waitForTimeout(Number(args.value ?? 1000));
        break;
    }
    return { matched: true, url: page.url(), elapsed_ms: Date.now() - start };
  } catch (err) {
    return {
      matched: false,
      url: page.url(),
      elapsed_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── get_popups ────────────────────────────────────────────────────────────────

export async function get_popups(
  args: { session_name: string },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  // String-based evaluate to avoid esbuild __name injection in browser sandbox
  const popupScript = `
    (() => {
      const modalSels = ${JSON.stringify(MODAL_SELECTORS)};
      const toastSels = ${JSON.stringify(TOAST_SELECTORS)};
      function isVis(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
      function selFor(el) { if (el.id) return '#' + el.id; const cls = Array.from(el.classList).slice(0, 2).join('.'); return cls ? el.tagName.toLowerCase() + '.' + cls : el.tagName.toLowerCase(); }
      const results = [];
      for (const sel of modalSels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVis(el)) continue;
          const titleEl = el.querySelector('[class*="title" i], [class*="header" i], h1, h2, h3, h4');
          const btns = Array.from(el.querySelectorAll('button, [role=button]')).filter(b => isVis(b)).map(b => ({ text: b.innerText.trim().slice(0, 60), selector: selFor(b) })).filter(b => b.text).slice(0, 8);
          results.push({ type: 'modal', selector: selFor(el), role: el.getAttribute('role'), title: titleEl ? titleEl.innerText.trim().slice(0, 120) : null, text: el.innerText.trim().slice(0, 400), buttons: btns });
        }
      }
      for (const sel of toastSels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVis(el)) continue;
          results.push({ type: 'toast', selector: selFor(el), role: el.getAttribute('role'), title: null, text: el.innerText.trim().slice(0, 200), buttons: [] });
        }
      }
      return results;
    })()
  `;

  const popups = await page.evaluate(popupScript);
  return { popups, count: (popups as unknown[]).length };
}

// ── dismiss ───────────────────────────────────────────────────────────────────

export async function dismiss(
  args: {
    session_name: string;
    button_text?: string;
    selector?: string;
    action?: 'confirm' | 'cancel' | 'close';
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    if (args.selector) {
      await page.locator(args.selector).click({ timeout: args.timeout_ms ?? 5_000 });
      return { dismissed: true, button_clicked: args.selector };
    }

    if (args.button_text) {
      await page
        .locator(`button:has-text("${args.button_text}"), [role=button]:has-text("${args.button_text}")`)
        .first()
        .click({ timeout: args.timeout_ms ?? 5_000 });
      return { dismissed: true, button_clicked: args.button_text };
    }

    // Action-based dismissal
    const actionMap: Record<string, string[]> = {
      confirm: ['OK', 'Yes', 'Confirm', 'Accept', 'Proceed', 'Submit'],
      cancel:  ['Cancel', 'No', 'Decline', 'Close', 'Dismiss'],
      close:   ['Close', '×', '✕', 'Dismiss'],
    };

    const candidates = args.action ? actionMap[args.action] : actionMap.close;
    for (const text of candidates) {
      const loc = page.locator(`button:has-text("${text}"), [role=button]:has-text("${text}"), [aria-label="${text}"]`);
      if (await loc.count() > 0) {
        await loc.first().click({ timeout: args.timeout_ms ?? 5_000 });
        return { dismissed: true, button_clicked: text };
      }
    }

    return { dismissed: false, error: 'No matching dismiss button found' };
  } catch (err) {
    return { dismissed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── scroll ────────────────────────────────────────────────────────────────────

export async function scroll(
  args: {
    session_name: string;
    selector?: string;
    direction?: 'down' | 'up' | 'top' | 'bottom';
    amount?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);

  try {
    if (args.selector) {
      await page.locator(args.selector).scrollIntoViewIfNeeded();
      return { done: true, method: 'scroll_into_view' };
    }

    const amount = args.amount ?? 300;
    switch (args.direction ?? 'down') {
      case 'down':
        await page.evaluate((y: number) => window.scrollBy(0, y), amount);
        break;
      case 'up':
        await page.evaluate((y: number) => window.scrollBy(0, -y), amount);
        break;
      case 'top':
        await page.evaluate(() => window.scrollTo(0, 0));
        break;
      case 'bottom':
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        break;
    }
    return { done: true };
  } catch (err) {
    return { done: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── take_screenshot ───────────────────────────────────────────────────────────

export async function take_screenshot(
  args: {
    session_name: string;
    filename?: string;
    highlight_selector?: string;
    full_page?: boolean;
  },
  _ctx: unknown,
): Promise<unknown> {
  const { page } = await getSession(args.session_name);
  await ensureDirs();

  // Highlight element if requested
  let removeHighlight: (() => Promise<void>) | null = null;
  if (args.highlight_selector) {
    try {
      await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        els.forEach(el => {
          (el as HTMLElement).setAttribute('data-uat-highlight', 'true');
          (el as HTMLElement).style.outline = '3px solid red';
        });
      }, args.highlight_selector);
      removeHighlight = async () => {
        await page.evaluate(() => {
          document.querySelectorAll('[data-uat-highlight]').forEach(el => {
            (el as HTMLElement).style.outline = '';
            el.removeAttribute('data-uat-highlight');
          });
        }).catch(() => {});
      };
    } catch { /* ignore highlight errors */ }
  }

  const slug = page
    .url()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]/gi, '_')
    .slice(0, 50);
  const filename = args.filename ?? `uat_${slug}_${Date.now()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);

  await page.screenshot({ path: filepath, fullPage: args.full_page ?? false });

  if (removeHighlight) await removeHighlight();

  return { filename, path: filepath, url: page.url() };
}

// ── close_browser ─────────────────────────────────────────────────────────────

export async function close_browser(
  args: { session_name: string },
  _ctx: unknown,
): Promise<unknown> {
  const existed = sessions.has(args.session_name);
  await killSession(args.session_name);
  return { closed: existed, session_name: args.session_name };
}

// ── list_sessions ─────────────────────────────────────────────────────────────

export async function list_sessions(
  _args: Record<string, unknown>,
  _ctx: unknown,
): Promise<unknown> {
  const result = Array.from(sessions.entries()).map(([name, entry]) => ({
    session_name: name,
    connected: entry.browser.isConnected(),
    url: entry.page.url(),
    has_saved_state: existsSync(sessionStatePath(name)),
  }));
  return { sessions: result, count: result.length };
}
