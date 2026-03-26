/**
 * selenium_testing skill
 * Provides Selenium WebDriver-based UI testing tools.
 * Requires: selenium-webdriver (npm), chromium-driver (system package)
 */

import { Builder, By, until, Key, WebDriver, WebElement } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ── Driver factory ────────────────────────────────────────────────────────────

const CHROMIUM_BIN = '/usr/bin/chromium';
const CHROMEDRIVER_BIN = '/usr/bin/chromedriver';
const SCREENSHOTS_DIR = '/root/.aura/workspace';

function buildDriver(): WebDriver {
  const options = new chrome.Options();
  options.setChromeBinaryPath(CHROMIUM_BIN);
  options.addArguments(
    '--headless',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,800',
  );

  const service = new chrome.ServiceBuilder(CHROMEDRIVER_BIN);

  return new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .setChromeService(service)
    .build();
}

async function withDriver<T>(
  fn: (driver: WebDriver) => Promise<T>,
): Promise<T> {
  const driver = buildDriver();
  try {
    return await fn(driver);
  } finally {
    await driver.quit().catch(() => {});
  }
}

async function ensureScreenshotsDir(): Promise<void> {
  if (!existsSync(SCREENSHOTS_DIR)) {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
  }
}

// ── Assertion helper ──────────────────────────────────────────────────────────

interface AssertionResult {
  name: string;
  passed: boolean;
  actual?: string;
  error?: string;
}

function makeAssert(results: AssertionResult[]) {
  return function assert(condition: boolean, name: string, actual?: string): void {
    results.push({ name, passed: !!condition, actual });
    if (!condition) {
      throw new Error(`Assertion failed: ${name}${actual ? ` (actual: ${actual})` : ''}`);
    }
  };
}

// ── run_test_script ───────────────────────────────────────────────────────────

export async function run_test_script(
  args: { url: string; script: string; timeout_ms?: number },
  _ctx: unknown,
): Promise<unknown> {
  const timeoutMs = args.timeout_ms ?? 30_000;
  const assertions: AssertionResult[] = [];
  const startMs = Date.now();

  let passed = false;
  let errorMessage: string | undefined;

  try {
    await withDriver(async (driver) => {
      await driver.manage().setTimeouts({ implicit: 5000, pageLoad: timeoutMs });
      await driver.get(args.url);

      const assert = makeAssert(assertions);

      // Build a sandboxed async function with the user's script body
      // Provide: driver, By, until, Key, assert
      const fn = new Function(
        'driver', 'By', 'until', 'Key', 'assert',
        `return (async () => { ${args.script} })();`,
      );

      await fn(driver, By, until, Key, assert);
      passed = true;
    });
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    // Mark last assertion as failed if it caused the throw
    if (assertions.length > 0 && assertions[assertions.length - 1].passed === undefined) {
      assertions[assertions.length - 1].passed = false;
    }
  }

  return {
    passed,
    error: errorMessage,
    assertions,
    total_assertions: assertions.length,
    passed_assertions: assertions.filter(a => a.passed).length,
    duration_ms: Date.now() - startMs,
    url: args.url,
  };
}

// ── assert_element ────────────────────────────────────────────────────────────

export async function assert_element(
  args: {
    url: string;
    selector: string;
    expected_text?: string;
    should_be_visible?: boolean;
    timeout_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const timeoutMs = args.timeout_ms ?? 10_000;
  const shouldBeVisible = args.should_be_visible !== false;
  const startMs = Date.now();

  let passed = false;
  let actual_text: string | undefined;
  let is_displayed: boolean | undefined;
  let errorMessage: string | undefined;

  try {
    await withDriver(async (driver) => {
      await driver.manage().setTimeouts({ implicit: timeoutMs, pageLoad: 30_000 });
      await driver.get(args.url);

      // Wait for element to be present in DOM
      const el: WebElement = await driver.wait(
        until.elementLocated(By.css(args.selector)),
        timeoutMs,
        `Element not found: ${args.selector}`,
      );

      actual_text = (await el.getText()).trim();
      is_displayed = await el.isDisplayed();

      if (shouldBeVisible && !is_displayed) {
        throw new Error(`Element "${args.selector}" is in DOM but not visible`);
      }

      if (args.expected_text !== undefined) {
        if (!actual_text.includes(args.expected_text)) {
          throw new Error(
            `Expected text "${args.expected_text}" not found in element. Actual: "${actual_text}"`,
          );
        }
      }

      passed = true;
    });
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  return {
    passed,
    selector: args.selector,
    actual_text,
    is_displayed,
    expected_text: args.expected_text,
    error: errorMessage,
    duration_ms: Date.now() - startMs,
    url: args.url,
  };
}

// ── fill_form ─────────────────────────────────────────────────────────────────

export async function fill_form(
  args: {
    url: string;
    fields: Array<{ selector: string; value: string; clear_first?: boolean }>;
    submit_selector?: string;
    wait_after_ms?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  const waitAfterMs = args.wait_after_ms ?? 2000;
  const startMs = Date.now();

  let passed = false;
  let result_url: string | undefined;
  let result_title: string | undefined;
  let errorMessage: string | undefined;
  const steps: Array<{ selector: string; status: 'ok' | 'error'; detail?: string }> = [];

  try {
    await withDriver(async (driver) => {
      await driver.manage().setTimeouts({ implicit: 10_000, pageLoad: 30_000 });
      await driver.get(args.url);

      for (const field of args.fields) {
        try {
          const el = await driver.wait(
            until.elementLocated(By.css(field.selector)),
            10_000,
          );
          if (field.clear_first !== false) {
            await el.clear();
          }
          await el.sendKeys(field.value);
          steps.push({ selector: field.selector, status: 'ok' });
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          steps.push({ selector: field.selector, status: 'error', detail });
          throw err;
        }
      }

      if (args.submit_selector) {
        const submitEl = await driver.wait(
          until.elementLocated(By.css(args.submit_selector)),
          10_000,
        );
        await submitEl.click();
        await driver.sleep(waitAfterMs);
      }

      result_url = await driver.getCurrentUrl();
      result_title = await driver.getTitle();
      passed = true;
    });
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  return {
    passed,
    steps,
    result_url,
    result_title,
    error: errorMessage,
    duration_ms: Date.now() - startMs,
    url: args.url,
  };
}

// ── take_test_screenshot ──────────────────────────────────────────────────────

export async function take_test_screenshot(
  args: {
    url: string;
    highlight_selector?: string;
    full_page?: boolean;
    filename?: string;
  },
  _ctx: unknown,
): Promise<unknown> {
  await ensureScreenshotsDir();
  const startMs = Date.now();

  let saved: string | undefined;
  let filename: string | undefined;
  let title: string | undefined;
  let errorMessage: string | undefined;
  let highlighted = false;

  try {
    await withDriver(async (driver) => {
      await driver.manage().setTimeouts({ implicit: 10_000, pageLoad: 30_000 });
      await driver.get(args.url);

      // Wait for body to be present
      await driver.wait(until.elementLocated(By.css('body')), 10_000);
      title = await driver.getTitle();

      if (args.highlight_selector) {
        try {
          const el = await driver.findElement(By.css(args.highlight_selector));
          await driver.executeScript(
            `arguments[0].style.outline = '3px solid red'; arguments[0].style.outlineOffset = '2px';`,
            el,
          );
          highlighted = true;
        } catch {
          // highlight failure is non-fatal
        }
      }

      if (args.full_page) {
        // Expand viewport to full page height before screenshot
        const pageHeight: number = await driver.executeScript(
          'return document.body.scrollHeight',
        ) as number;
        await driver.manage().window().setRect({ width: 1280, height: pageHeight });
      }

      const slug = args.url
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]/gi, '_')
        .slice(0, 60);
      filename = args.filename ?? `${slug}_${Date.now()}.png`;
      saved = join(SCREENSHOTS_DIR, filename);

      const png: string = await driver.takeScreenshot();
      const { writeFile } = await import('fs/promises');
      await writeFile(saved, Buffer.from(png, 'base64'));
    });
  } catch (err: unknown) {
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

// ── generate_test ─────────────────────────────────────────────────────────────

export async function generate_test(
  args: {
    url: string;
    focus?: 'full' | 'forms' | 'navigation' | 'accessibility' | 'performance';
  },
  _ctx: unknown,
): Promise<unknown> {
  const focus = args.focus ?? 'full';
  const startMs = Date.now();

  let inspection: Record<string, unknown> = {};
  let errorMessage: string | undefined;

  try {
    await withDriver(async (driver) => {
      await driver.manage().setTimeouts({ implicit: 10_000, pageLoad: 30_000 });
      await driver.get(args.url);
      await driver.wait(until.elementLocated(By.css('body')), 10_000);

      const pageTitle = await driver.getTitle();
      const currentUrl = await driver.getCurrentUrl();

      const data: Record<string, unknown> = await driver.executeScript(`
        const result = {};
        result.title = document.title;
        result.headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 10).map(h => ({
          tag: h.tagName.toLowerCase(),
          text: h.innerText.trim().slice(0, 80),
        }));
        result.forms = Array.from(document.querySelectorAll('form')).slice(0, 5).map(f => ({
          id: f.id || null,
          action: f.action || null,
          inputs: Array.from(f.querySelectorAll('input,select,textarea')).slice(0, 10).map(i => ({
            type: i.type || i.tagName.toLowerCase(),
            name: i.name || i.id || null,
            placeholder: i.placeholder || null,
            required: i.required || false,
          })),
          submit: f.querySelector('[type=submit]')?.innerText?.trim() || null,
        }));
        result.nav_links = Array.from(document.querySelectorAll('nav a, header a')).slice(0, 10).map(a => ({
          text: a.innerText.trim().slice(0, 40),
          href: a.href,
        }));
        result.images_without_alt = document.querySelectorAll('img:not([alt])').length;
        result.lang = document.documentElement.lang || null;
        return result;
      `) as Record<string, unknown>;

      inspection = { pageTitle, currentUrl, ...data };
    });
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // Build the test script from what we found
  const script = buildTestScript(args.url, inspection, focus);

  return {
    url: args.url,
    focus,
    inspection,
    generated_script: script,
    usage: `Pass generated_script directly to run_test_script with url: "${args.url}"`,
    error: errorMessage,
    duration_ms: Date.now() - startMs,
  };
}

// ── Test script generator ─────────────────────────────────────────────────────

function buildTestScript(
  url: string,
  data: Record<string, unknown>,
  focus: string,
): string {
  const lines: string[] = [];

  const headings = (data.headings as Array<{ tag: string; text: string }>) ?? [];
  const forms = (data.forms as Array<{
    id: string | null;
    inputs: Array<{ name: string | null; type: string; required: boolean }>;
    submit: string | null;
  }>) ?? [];
  const navLinks = (data.nav_links as Array<{ text: string; href: string }>) ?? [];
  const imagesWithoutAlt = (data.images_without_alt as number) ?? 0;
  const lang = data.lang as string | null;

  lines.push(`// Auto-generated Selenium test for: ${url}`);
  lines.push(`// Focus: ${focus}`);
  lines.push('');
  lines.push(`// 1. Verify page loaded`);
  lines.push(`const title = await driver.getTitle();`);
  lines.push(`assert(title.length > 0, 'page title should not be empty', title);`);

  if (data.pageTitle) {
    lines.push(`assert(title === ${JSON.stringify(data.pageTitle)}, 'page title matches expected', title);`);
  }

  if (focus === 'full' || focus === 'navigation') {
    lines.push('');
    lines.push(`// 2. Verify page has navigable structure`);
    lines.push(`const body = await driver.findElement(By.css('body'));`);
    lines.push(`const bodyText = await body.getText();`);
    lines.push(`assert(bodyText.length > 50, 'page body has content', \`\${bodyText.length} chars\`);`);

    if (headings.length > 0) {
      const h1 = headings.find(h => h.tag === 'h1');
      if (h1) {
        lines.push(`const h1 = await driver.findElement(By.css('h1'));`);
        lines.push(`const h1Text = await h1.getText();`);
        lines.push(`assert(h1Text.length > 0, 'h1 heading exists and has text', h1Text);`);
      }
    }

    if (navLinks.length > 0) {
      lines.push(`const navLinks = await driver.findElements(By.css('nav a, header a'));`);
      lines.push(`assert(navLinks.length > 0, 'navigation links are present', \`\${navLinks.length} found\`);`);
    }
  }

  if ((focus === 'full' || focus === 'forms') && forms.length > 0) {
    lines.push('');
    lines.push(`// 3. Verify form elements are present and interactive`);
    const form = forms[0];
    const requiredInputs = form.inputs.filter(i => i.required && i.name);
    if (requiredInputs.length > 0) {
      for (const input of requiredInputs.slice(0, 3)) {
        const selector = `[name="${input.name}"]`;
        lines.push(`const field_${input.name?.replace(/\W/g, '_')} = await driver.findElement(By.css('${selector}'));`);
        lines.push(`assert(await field_${input.name?.replace(/\W/g, '_')}.isDisplayed(), 'required field "${input.name}" is visible');`);
      }
    } else {
      lines.push(`const forms = await driver.findElements(By.css('form'));`);
      lines.push(`assert(forms.length > 0, 'at least one form is present', \`\${forms.length} found\`);`);
    }
  }

  if (focus === 'full' || focus === 'accessibility') {
    lines.push('');
    lines.push(`// 4. Basic accessibility checks`);
    if (lang) {
      lines.push(`const htmlLang = await driver.executeScript('return document.documentElement.lang');`);
      lines.push(`assert(htmlLang && htmlLang.length > 0, 'html element has lang attribute', String(htmlLang));`);
    }
    if (imagesWithoutAlt > 0) {
      lines.push(`const imgsNoAlt = await driver.executeScript('return document.querySelectorAll("img:not([alt])").length');`);
      lines.push(`assert(Number(imgsNoAlt) === 0, 'all images have alt attributes', \`\${imgsNoAlt} missing\`);`);
    }
    lines.push(`const mainContent = await driver.findElements(By.css('main, [role="main"], #main, #content'));`);
    lines.push(`assert(mainContent.length > 0, 'page has a main content landmark');`);
  }

  if (focus === 'performance') {
    lines.push('');
    lines.push(`// 5. Performance checks`);
    lines.push(`const perfData = await driver.executeScript(\`
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
    loadComplete: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
  };
\`);`);
    lines.push(`assert(perfData.domContentLoaded !== null, 'DOMContentLoaded timing available');`);
    lines.push(`assert(perfData.domContentLoaded < 5000, 'DOMContentLoaded under 5s', \`\${perfData.domContentLoaded}ms\`);`);
    lines.push(`assert(perfData.loadComplete < 10000, 'full load under 10s', \`\${perfData.loadComplete}ms\`);`);
  }

  return lines.join('\n');
}
