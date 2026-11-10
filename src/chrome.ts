import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FLOW_URL = "https://flow.google.com/";
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that: `hl=es` turned every label Spanish on
// an English account (2026-10-13), the choice holds through Flow's in-app navigation, and the browser's own language
// changes nothing. It only lasts until the next full page load, so every load adds it and ensureEnglish re-checks.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
export const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  return chromePath;
}

async function launchChrome(): Promise<void> {
  const chromePath = chromeExecutable();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Several lanes drive Flow at once, each in its own window, and most of them sit behind another window. Without
      // these Chrome slows hidden or covered windows down and Flow's menus and uploads stall there.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      inEnglish(FLOW_URL),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${CDP_PORT} never came up.`);
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

// A lane is one Flow tab with its own project and its own queue. Every MCP process (one per agent session) gets its own
// lane, so two sessions no longer fight over one tab: before lanes, one session opening a project moved every other
// session's queued work into it (2026-11-10, EP020 jobs ran in another session's project or never ran at all).
// The lane of the current call travels with it through AsyncLocalStorage, so every getFlowPage() below picks the
// right tab without each Flow helper being told which one.
export interface Lane {
  key: string;
  page?: Page;
  // The project this lane last had open. A tab that was closed comes back here.
  projectUrl?: string;
}
export const MAIN_LANE = "main";
const lanes = new Map<string, Lane>();
const laneStore = new AsyncLocalStorage<Lane>();

export const laneOf = (key: string): Lane => {
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = { key }));
  return lane;
};
export const currentLane = (): Lane => laneStore.getStore() ?? laneOf(MAIN_LANE);
export const inLane = <T>(key: string, work: () => T): T => laneStore.run(laneOf(key), work);
export const allLanes = (): Lane[] => [...lanes.values()];
// Set by the core: whether a lane still has queued or running jobs (its tab must not be handed to another lane).
let laneBusy: (key: string) => boolean = () => false;
export const setLaneBusy = (fn: (key: string) => boolean): void => {
  laneBusy = fn;
};

// "pid:<n>" lanes belong to an MCP client process; once that process is gone its tab may be reused.
const laneAlive = (key: string): boolean => {
  const pid = Number(key.match(/^pid:(\d+)$/)?.[1]);
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const projectOf = (url: string) => url.match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];

// Chrome slows down a tab that is not in front. Telling the page it is focused and active keeps Flow's timers,
// animations and uploads running in every lane's window.
async function keepAwake(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page).catch(() => undefined);
  if (!cdp) return;
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
}

// A new top-level window rather than a tab: a background tab is hidden, and Flow does not finish its work there.
async function openLaneWindow(url: string): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const cdp = await b.newBrowserCDPSession();
  const arrived = context.waitForEvent("page", { timeout: 20_000 });
  await cdp.send("Target.createTarget", { url, newWindow: true });
  const page = await arrived;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return page;
}

export async function getFlowPage(): Promise<Page> {
  const lane = currentLane();
  if (lane.page && !lane.page.isClosed()) {
    await ensureEnglish(lane.page);
    const at = projectOf(lane.page.url());
    if (at) lane.projectUrl = at;
    return lane.page;
  }
  lane.page = undefined;
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  // Lanes whose MCP process has exited and that have nothing left to run: close their window so they do not pile up.
  for (const other of [...lanes.values()]) {
    if (other === lane || laneAlive(other.key) || laneBusy(other.key)) continue;
    await other.page?.close().catch(() => {});
    lanes.delete(other.key);
  }
  const taken = new Set(allLanes().map((l) => l.page).filter(Boolean));
  const free = context.pages().filter((p) => FLOW_HOSTS.test(p.url()) && !taken.has(p));
  // The main lane takes the Flow tab the user already has (as before lanes). Other lanes only take a free tab that
  // already shows their own project; otherwise they get a window of their own, so they never take the user's tab.
  const page =
    (lane.projectUrl && free.find((p) => projectOf(p.url()) === lane.projectUrl)) ||
    (lane.key === MAIN_LANE ? free[0] : undefined) ||
    (await openLaneWindow(inEnglish(lane.projectUrl ?? FLOW_URL)));
  lane.page = page;
  await keepAwake(page);
  if (lane.projectUrl && projectOf(page.url()) !== lane.projectUrl && !/accounts\.google\.com/.test(page.url())) {
    await page.goto(inEnglish(lane.projectUrl), { waitUntil: "domcontentloaded" });
  }
  await ensureEnglish(page);
  const at = projectOf(page.url());
  if (at) lane.projectUrl = at;
  return page;
}

// Reloads Flow in English when it is showing in another language (a page the user opened by hand, or Flow redirecting
// to an address without hl). Sign-in pages are left alone.
export async function ensureEnglish(page: Page): Promise<void> {
  if (!/^https:\/\/flow\.google\.com\//.test(page.url())) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(
      `Flow is showing in "${after}" and would not switch to English. flow-mcp finds Flow's buttons by their English names. ` +
        `Add ?hl=en to the end of Flow's address in the Flow Chrome window, or set your Google account's language to English (myaccount.google.com/language).`,
    );
  }
}
