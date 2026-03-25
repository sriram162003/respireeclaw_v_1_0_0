import { chromium, Browser, BrowserContext } from 'playwright';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

// ── Browser singleton ────────────────────────────────────────────────────────
// Reuse a single browser instance; close it after 5 min of inactivity.
let _browser: Browser | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 5 * 60 * 1000;
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--headless',
];

async function getBrowser(): Promise<Browser> {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      executablePath: '/usr/bin/chromium',
      args: CHROMIUM_ARGS,
    });
  }
  _idleTimer = setTimeout(async () => {
    if (_browser?.isConnected()) await _browser.close().catch(() => {});
    _browser = null;
    _idleTimer = null;
  }, IDLE_MS);
  return _browser;
}

async function newCtx(): Promise<BrowserContext> {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
  });
}

// ── search ────────────────────────────────────────────────────────────────────
export async function search(
  args: { query: string; num?: number },
  _ctx: unknown,
): Promise<unknown> {
  const num = Math.min(args.num ?? 8, 20);
  const ctx = await newCtx();
  const page = await ctx.newPage();

  try {
    // Block images/fonts/media to keep it fast
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
      { waitUntil: 'domcontentloaded', timeout: 20000 },
    );

    const results = await page.evaluate((maxN: number) => {
      const out: Array<{ title: string; snippet: string; url: string }> = [];
      const items = document.querySelectorAll('.result');
      for (const item of Array.from(items).slice(0, maxN)) {
        const titleEl = item.querySelector('.result__title a');
        const snippetEl = item.querySelector('.result__snippet');
        const urlEl = item.querySelector('.result__url');
        if (!titleEl) continue;
        const href = (titleEl as HTMLAnchorElement).href || '';
        // DuckDuckGo wraps links — extract uddg param
        let url = href;
        try {
          const u = new URL(href);
          url = u.searchParams.get('uddg') || u.searchParams.get('u') || href;
        } catch {}
        out.push({
          title: titleEl.textContent?.trim() || '',
          snippet: snippetEl?.textContent?.trim() || '',
          url: url,
        });
      }
      return out;
    }, num);

    if (!results.length) {
      return [{
        title: args.query,
        snippet: 'No results found.',
        url: `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`,
      }];
    }
    return results;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── browse ────────────────────────────────────────────────────────────────────
export async function browse(
  args: { url: string; extract?: 'text' | 'links' | 'both' },
  _ctx: unknown,
): Promise<unknown> {
  const extract = args.extract ?? 'text';
  const ctx = await newCtx();
  const page = await ctx.newPage();

  try {
    if (extract === 'text') {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) route.abort();
        else route.continue();
      });
    }

    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait a beat for JS-rendered content
    await page.waitForTimeout(800);

    const result: Record<string, unknown> = { url: page.url(), title: await page.title() };

    if (extract === 'text' || extract === 'both') {
      const text = await page.evaluate(() => {
        // Remove noisy elements
        const remove = ['script','style','nav','footer','header','aside',
          '[role="banner"]','[role="navigation"]','[role="complementary"]',
          '.cookie-banner','.cookie-notice','.ad','.ads','.advertisement'];
        remove.forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));

        // Prefer main content containers
        const main =
          document.querySelector('main') ||
          document.querySelector('article') ||
          document.querySelector('[role="main"]') ||
          document.querySelector('#content') ||
          document.querySelector('#main') ||
          document.body;

        const raw = main?.innerText || document.body.innerText || '';
        // Collapse excessive whitespace
        return raw.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 12000);
      });
      result['text'] = text;
      result['length'] = text.length;
    }

    if (extract === 'links' || extract === 'both') {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({
            text: (a as HTMLAnchorElement).textContent?.trim() || '',
            href: (a as HTMLAnchorElement).href,
          }))
          .filter(l => l.href.startsWith('http') && l.text.length > 0)
          .slice(0, 50);
      });
      result['links'] = links;
    }

    return result;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── screenshot ────────────────────────────────────────────────────────────────
export async function screenshot(
  args: { url: string; full_page?: boolean },
  _ctx: unknown,
): Promise<unknown> {
  const screenshotsDir = '/root/.aura/workspace/screenshots';
  if (!existsSync(screenshotsDir)) {
    await mkdir(screenshotsDir, { recursive: true });
  }

  const ctx = await newCtx();
  const page = await ctx.newPage();

  try {
    await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);

    const slug = args.url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]/gi, '_')
      .slice(0, 60);
    const filename = `${slug}_${Date.now()}.png`;
    const filepath = join(screenshotsDir, filename);

    await page.screenshot({
      path: filepath,
      fullPage: args.full_page ?? false,
    });

    return {
      saved: filepath,
      filename,
      url: args.url,
      title: await page.title(),
      full_page: args.full_page ?? false,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}
