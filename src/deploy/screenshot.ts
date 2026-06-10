import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';
import { logger } from '../logger.js';

/**
 * AC-B3: screenshot of the real deployed page via headless Chromium.
 * Hits the container directly over the project network — works even before
 * public DNS propagates. Failure to screenshot never fails a deploy.
 */
export async function takeScreenshot(url: string, slug: string): Promise<string | null> {
  try {
    const { chromium } = await import('playwright');
    fs.mkdirSync(paths.screenshotsDir(), { recursive: true });
    const file = path.join(paths.screenshotsDir(), `${slug}-${Date.now()}.png`);
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.screenshot({ path: file });
    } finally {
      await browser.close();
    }
    return file;
  } catch (e) {
    logger.warn('screenshot failed', { url, error: (e as Error).message });
    return null;
  }
}
