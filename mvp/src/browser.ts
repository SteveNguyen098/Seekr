import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface OpenBrowserOptions {
  headed: boolean;
  useProfile: boolean;
  profileDir: string;
  /** 0 disables tab-sharing entirely. */
  cdpPort: number;
  launchArgs: string[];
}

export interface OpenedBrowser {
  context: BrowserContext;
  page: Page;
  /** True when this run is a tab in a browser someone else is hosting. */
  attached: boolean;
  /** Tears down exactly what this run owns - and nothing it borrowed. */
  close(): Promise<void>;
}

/**
 * Opens the browser a run works in, and hands back the teardown that
 * matches how it was opened.
 *
 * Opening and closing live in one place deliberately. They were previously
 * a ternary and a separate one-liner two hundred lines apart, and the bug
 * that produced was invisible: a plain launch's Browser was discarded at
 * birth, so closing the context left Chromium running and the run never
 * ended. Measured at the time - after context.close() the plain-launch path
 * left ["PipeWrap" x4, "ProcessWrap"] holding Node's event loop open, while
 * the persistent path left none.
 *
 * Three ownership shapes, three teardowns:
 *   attached   - borrowed; close only our own tab
 *   persistent - the context owns its browser; closing it is enough
 *   launched   - the context does NOT own its browser; close both
 */
export async function openBrowser(opts: OpenBrowserOptions): Promise<OpenedBrowser> {
  const { headed, useProfile, profileDir, cdpPort } = opts;
  // Copied, not mutated: the caller's array is reused across retries.
  const launchArgs = [...opts.launchArgs];

  if (cdpPort) {
    try {
      const shared = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5000 });
      const ctx = shared.contexts()[0];
      if (ctx) {
        // No viewport is set here on purpose: a tab shares the host
        // window's dimensions, and forcing one would resize that window
        // out from under every other tab already open in it.
        const page = await ctx.newPage();
        return {
          context: ctx,
          page,
          attached: true,
          close: async () => void (await page.close().catch(() => {})),
        };
      }
      // Connected but no context to put a tab in - unusable, so fall
      // through and host our own rather than proceeding half-attached.
    } catch {
      /* nothing listening yet (or it died) - we become the host below */
    }
  }

  // Fallback and first-run path alike. --profile matters here and only
  // here: an attached tab uses the host's profile, but a job that failed to
  // attach *cannot* use the host's directory even if it wanted to, because
  // that lock is exactly what it just failed to get past.
  if (cdpPort) launchArgs.push(`--remote-debugging-port=${cdpPort}`);

  if (useProfile) {
    // A persistent context OWNS its browser: closing the context closes the
    // process too, so there is nothing else to hold on to.
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      viewport: { width: 1280, height: 900 },
      args: launchArgs,
    });
    return {
      context: ctx,
      page: ctx.pages()[0] ?? (await ctx.newPage()),
      attached: false,
      close: async () => void (await ctx.close().catch(() => {})),
    };
  }

  // A plain launch does not. Keep the Browser and close it explicitly, or
  // the Chromium process outlives the run and nothing ever exits.
  const launched: Browser = await chromium.launch({ headless: !headed, args: launchArgs });
  const ctx = await launched.newContext({ viewport: { width: 1280, height: 900 } });
  return {
    context: ctx,
    page: ctx.pages()[0] ?? (await ctx.newPage()),
    attached: false,
    close: async () => {
      await ctx.close().catch(() => {});
      await launched.close().catch(() => {});
    },
  };
}
