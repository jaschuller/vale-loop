"use strict";

/**
 * Track A: knock on one existing Grok conversation in a persistent Chrome profile.
 * Not the xAI API. Does not start a new chat.
 *
 * Grok's UI changes. Update the selector lists below after inspecting the page.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { containsStop, looksLikeLimit } = require("./parse-reply");

const ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

// Try these in order. Use the actual live Grok editor element.
const COMPOSER_SELECTORS = [
  'div[role="textbox"][contenteditable="true"].tiptap.ProseMirror',
  'div[role="textbox"][contenteditable="true"]',
  '.tiptap.ProseMirror[contenteditable="true"]',
];

const SEND_SELECTORS = [
  'button[aria-label="Submit"]',
  'button[data-testid="chat-submit"]'
];

const ASSISTANT_SELECTORS = [
  '[data-testid="assistant-message"]',
  '.message-bubble'
];

const POLL_MS = 2000;
const STABLE_MS = 8000;
const REPLY_TIMEOUT_MS = 4 * 60 * 1000;
const SUBMIT_CHECK_MS = 1500;

function log(msg) {
  console.log(`${new Date().toISOString()}  ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(msg, code = 1) {
  console.error(`${new Date().toISOString()}  ${msg}`);
  process.exit(code);
}

function envPath(name, fallback) {
  const raw = process.env[name] || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const ENABLED = process.env.ENABLED === "1";
const GROK_CONVO_URL = (process.env.GROK_CONVO_URL || "").trim();
const INTERVAL_MIN = Math.max(1, Number(process.env.INTERVAL_MIN) || 90);
const HEADLESS = process.env.HEADLESS === "1";
const USE_EXISTING_BROWSER = process.env.USE_EXISTING_BROWSER === "1";
const CHROME_REMOTE_DEBUG_URL = (process.env.CHROME_REMOTE_DEBUG_URL || "").trim();
const USER_DATA_DIR = envPath("USER_DATA_DIR", "./user-data");
const KNOCK_FILE = envPath("KNOCK_FILE", "./prompts/knock.md");
const OUT_DIR = envPath("OUT_DIR", "./out");
const DISABLED_PATH = path.join(OUT_DIR, "DISABLED");
const REPLY_PATH = path.join(OUT_DIR, "last-reply.md");
const LOG_PATH = path.join(OUT_DIR, "log.jsonl");

const args = process.argv.slice(2);
const once = args.includes("--once");
const force = args.includes("--force");

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

function readKnock() {
  if (!fs.existsSync(KNOCK_FILE)) {
    die(`Knock file missing: ${KNOCK_FILE}`);
  }
  const text = fs.readFileSync(KNOCK_FILE, "utf8").trim();
  if (!text) die(`Knock file is empty: ${KNOCK_FILE}`);
  return text;
}

function writeReply(text) {
  fs.writeFileSync(REPLY_PATH, text == null ? "" : String(text), "utf8");
}

function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

function writeDisabled(reason) {
  const body = `${reason}\n${new Date().toISOString()}\n`;
  fs.writeFileSync(DISABLED_PATH, body, "utf8");
  log(`wrote ${DISABLED_PATH} (${reason})`);
}

function isDisabled() {
  return fs.existsSync(DISABLED_PATH);
}

function logKnock({ ok, stopped, reason, chars }) {
  const row = {
    ts: new Date().toISOString(),
    ok,
    stopped,
    reason,
    chars,
  };
  appendLog(row);
  log(`log ${JSON.stringify(row)}`);
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).last();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        return { loc, sel };
      }
    } catch {
      // stale node; try next
    }
  }
  return null;
}

async function findComposer(page) {
  const found = await firstVisible(page, COMPOSER_SELECTORS);
  if (!found) {
    throw new Error(
      "Composer not found. Log in if the profile is cold, then update COMPOSER_SELECTORS in src/loop.js."
    );
  }
  log(`composer: ${found.sel}`);
  return found.loc;
}

async function getLastAssistantText(page) {
  for (const sel of ASSISTANT_SELECTORS) {
    const loc = page.locator(sel);
    const n = await loc.count();
    if (n === 0) continue;
    try {
      const text = (await loc.nth(n - 1).innerText()).trim();
      if (text) return text;
    } catch {
      // ignore
    }
  }
  return page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const composer = document.querySelector(
      'textarea, [contenteditable="true"]'
    );
    const composerText = composer
      ? (composer.value || composer.innerText || "").trim()
      : "";
    const blocks = [...main.querySelectorAll("div, p, article")]
      .map((el) => (el.innerText || "").trim())
      .filter((t) => t.length > 40 && t !== composerText);
    return blocks.length ? blocks[blocks.length - 1] : "";
  });
}

async function pageText(page) {
  try {
    return (await page.locator("body").innerText({ timeout: 5000 })) || "";
  } catch {
    return "";
  }
}

async function pageLooksLimited(page) {
  const text = await pageText(page);
  if (looksLikeLimit(text)) return true;
  const banner = page.locator(
    '[role="alert"], [data-testid*="banner" i], [class*="banner" i]'
  );
  const n = await banner.count();
  for (let i = 0; i < n; i += 1) {
    try {
      const t = (await banner.nth(i).innerText()).trim();
      if (looksLikeLimit(t) || /\bstopped\b/i.test(t)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function knockLanded(page, composer, knock) {
  try {
    const value = await composer.evaluate((el) =>
      (el.value || el.innerText || "").trim()
    );
    if (!value) return true;
  } catch {
    return true;
  }
  const snippet = knock.trim().slice(0, 80);
  return page.evaluate((s) => {
    const composerEl = document.querySelector(
      'textarea, [contenteditable="true"]'
    );
    const root = document.querySelector("main") || document.body;
    const text = root.innerText || "";
    const ctext = composerEl
      ? composerEl.value || composerEl.innerText || ""
      : "";
    const first = text.indexOf(s);
    if (first === -1) return false;
    if (!ctext.includes(s)) return true;
    return text.indexOf(s, first + 1) !== -1;
  }, snippet);
}

async function clickSend(page) {
  const found = await firstVisible(page, SEND_SELECTORS);
  if (!found) return false;
  await found.loc.click();
  log(`submit: click ${found.sel}`);
  return true;
}

async function submitKnock(page, composer, knock) {
  await composer.click();
  await composer.fill(knock);

  await composer.press("Enter");
  await sleep(SUBMIT_CHECK_MS);
  if (await knockLanded(page, composer, knock)) {
    log("submit: Enter");
    return "Enter";
  }

  if (await clickSend(page)) {
    await sleep(SUBMIT_CHECK_MS);
    if (await knockLanded(page, composer, knock)) return "Send";
  }

  throw new Error(
    "Could not submit knock (Enter and Send both failed). Update SEND_SELECTORS in src/loop.js."
  );
}

async function waitForReply(page, before) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let current = before;
  let changed = false;
  let stableSince = null;

  while (Date.now() < deadline) {
    if (await pageLooksLimited(page)) {
      return { text: current === before ? await getLastAssistantText(page) : current, limit: true };
    }

    current = await getLastAssistantText(page);
    if (current && current !== before) {
      if (!changed) {
        changed = true;
        log("assistant text changed; waiting for it to settle");
      }
      if (stableSince == null) {
        stableSince = Date.now();
      }
      // Re-read after the stable window. If it grew (streaming), reset.
      if (Date.now() - stableSince >= STABLE_MS) {
        await sleep(POLL_MS);
        const again = await getLastAssistantText(page);
        if (again === current) {
          return { text: current, limit: false };
        }
        current = again;
        stableSince = Date.now();
      }
    } else {
      stableSince = null;
    }

    await sleep(POLL_MS);
  }

  return { text: changed ? current : "", limit: false, timeout: true };
}

async function knockOnce(page, knock) {
  if (!GROK_CONVO_URL) {
    die("GROK_CONVO_URL is empty. Paste the existing conversation URL into .env.");
  }

  const composer = await findComposer(page);
  const before = await getLastAssistantText(page);

  await submitKnock(page, composer, knock);

  const result = await waitForReply(page, before);
  const text = result.text || "";
  writeReply(text);

  if (result.limit || looksLikeLimit(text)) {
    writeDisabled("usage-limit");
    logKnock({ ok: false, stopped: true, reason: "usage-limit", chars: text.length });
    return { stop: true };
  }

  if (containsStop(text)) {
    writeDisabled("stop-phrase");
    logKnock({ ok: true, stopped: true, reason: "stop-phrase", chars: text.length });
    return { stop: true };
  }

  if (result.timeout) {
    logKnock({ ok: false, stopped: false, reason: "timeout", chars: text.length });
    log("timed out waiting for a stable assistant reply (4 min)");
    return { stop: false };
  }

  logKnock({ ok: true, stopped: false, reason: "ok", chars: text.length });
  log(`saved ${REPLY_PATH} (${text.length} chars)`);
  return { stop: false };
}

function assertCanRun(isFirst) {
  if (isDisabled()) {
    die("out/DISABLED exists; delete it to run again");
  }
  if (!GROK_CONVO_URL) {
    die("GROK_CONVO_URL is empty. Paste the existing conversation URL into .env.");
  }
  if (!ENABLED && !(force && isFirst)) {
    die("ENABLED=0. Set ENABLED=1 in .env, or dry-run with: node src/loop.js --once --force");
  }
}

async function openBrowser() {
  if (USE_EXISTING_BROWSER || CHROME_REMOTE_DEBUG_URL) {
    const url = CHROME_REMOTE_DEBUG_URL || "http://localhost:9222";
    log(`attaching to existing Chrome via CDP at ${url}`);
    const browser = await chromium.connectOverCDP(url);
    const context = browser.contexts()[0] || (await browser.newContext({ viewport: { width: 1280, height: 900 } }));
    const page = context.pages()[0] || (await context.newPage());

    return { browser, context, page, shouldCloseBrowser: false };
  }

  log(`launching fresh persistent browser profile at ${USER_DATA_DIR}`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());
  return { browser: null, context, page, shouldCloseBrowser: true };
}

async function main() {
  ensureDirs();
  assertCanRun(true);
  const knock = readKnock();

  log(
    `start once=${once} force=${force} headless=${HEADLESS} interval=${INTERVAL_MIN}m existingBrowser=${USE_EXISTING_BROWSER || !!CHROME_REMOTE_DEBUG_URL}`
  );

  const { context, page, browser, shouldCloseBrowser } = await openBrowser();

  console.log("URL:", GROK_CONVO_URL);
  console.log("title:", await page.title());

  try {
    let first = true;
    while (true) {
      assertCanRun(first);
      const { stop } = await knockOnce(page, knock);
      if (stop) {
        log("stopping");
        break;
      }
      if (once) break;
      // --force only covers the first headed dry run, not a disabled loop.
      if (process.env.ENABLED !== "1") {
        log("ENABLED is not 1; not looping");
        break;
      }
      first = false;
      log(`sleeping ${INTERVAL_MIN} min`);
      await sleep(INTERVAL_MIN * 60 * 1000);
    }
  } catch (err) {
    log(`error: ${err.message || err}`);
    logKnock({
      ok: false,
      stopped: false,
      reason: String(err.message || err).slice(0, 200),
      chars: 0,
    });
    throw err;
  } finally {
    if (shouldCloseBrowser) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
