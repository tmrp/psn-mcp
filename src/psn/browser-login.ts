import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const LOGIN_URL = "https://www.playstation.com/";

interface BrowserLoginSession {
  browser: ChildProcess;
  port: number;
  userDataDir: string;
}

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

interface CdpCookie {
  name: string;
  value: string;
}

type CdpListener = (event: { data?: unknown; error?: unknown }) => void;

interface CdpSocket {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: CdpListener,
    options?: { once?: boolean },
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: CdpListener,
  ): void;
  close(): void;
  send(data: string): void;
}

let activeSession: BrowserLoginSession | null = null;

export interface BeginBrowserLoginResult {
  loginUrl: string;
  message: string;
}

export interface CompleteBrowserLoginResult {
  npsso: string;
}

export function hasActiveBrowserLogin(): boolean {
  return activeSession !== null;
}

export async function beginBrowserLogin(): Promise<BeginBrowserLoginResult> {
  if (activeSession) {
    return {
      loginUrl: LOGIN_URL,
      message:
        "A PSN login browser is already open. Sign in there, then call psn_complete_login.",
    };
  }

  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error(
      "Could not find a supported browser. Install Chrome, Edge, Brave, or Chromium, " +
        "or set PSN_BROWSER_PATH to the browser executable.",
    );
  }

  const port = await getAvailablePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "psn-mcp-login-"));
  const browser = spawn(
    browserPath,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      LOGIN_URL,
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  browser.unref();

  activeSession = { browser, port, userDataDir };
  try {
    await waitForDebugger(port);
  } catch (error) {
    await cleanupActiveSession();
    throw error;
  }

  return {
    loginUrl: LOGIN_URL,
    message:
      "A browser window was opened with an isolated profile. Sign in to PlayStation, " +
      "then call psn_complete_login to capture the session automatically.",
  };
}

export async function completeBrowserLogin(): Promise<CompleteBrowserLoginResult> {
  if (!activeSession) {
    throw new Error(
      "No PSN browser login is active. Call psn_begin_login first.",
    );
  }

  const npsso = await readNpssoCookie(activeSession.port);
  if (!npsso) {
    throw new Error(
      "Could not find an NPSSO cookie yet. Finish signing in to PlayStation in " +
        "the opened browser window, then call psn_complete_login again.",
    );
  }

  await cleanupActiveSession();
  return { npsso };
}

export async function cancelBrowserLogin(): Promise<void> {
  await cleanupActiveSession();
}

function findBrowserPath(): string | null {
  if (process.env.PSN_BROWSER_PATH) return process.env.PSN_BROWSER_PATH;

  const candidates = browserCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function browserCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ];
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Could not allocate a local debugger port."));
        }
      });
    });
  });
}

async function waitForDebugger(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Browser is still starting.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the browser debugging endpoint.");
}

async function readNpssoCookie(port: number): Promise<string | null> {
  const targets = (await fetchJson(
    `http://127.0.0.1:${port}/json/list`,
  )) as CdpTarget[];
  const page = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("Could not find the browser page debugging target.");
  }

  const socket = await openCdpSocket(page.webSocketDebuggerUrl);
  try {
    // Storage.getCookies is the non-deprecated replacement for the older
    // Network.getAllCookies; both return every cookie in the browser context.
    const response = await sendCdp<{ cookies: CdpCookie[] }>(
      socket,
      "Storage.getCookies",
    );
    const cookie = response.cookies.find(
      (candidate) =>
        candidate.name.toLowerCase() === "npsso" && candidate.value,
    );
    return cookie?.value ?? null;
  } finally {
    socket.close();
  }
}

async function openCdpSocket(url: string): Promise<CdpSocket> {
  const WebSocketCtor = (
    globalThis as unknown as { WebSocket?: new (url: string) => CdpSocket }
  ).WebSocket;
  if (!WebSocketCtor) {
    throw new Error(
      "This Node.js runtime does not expose WebSocket. Use Node.js 24.18+ for browser login.",
    );
  }

  const socket = new WebSocketCtor(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      (event) =>
        reject(event.error ?? new Error("WebSocket connection failed.")),
      { once: true },
    );
  });
  return socket;
}

async function sendCdp<T>(socket: CdpSocket, method: string): Promise<T> {
  const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  return new Promise<T>((resolve, reject) => {
    const onMessage: CdpListener = (event) => {
      const data = JSON.parse(String(event.data)) as {
        id?: number;
        result?: T;
        error?: { message?: string };
      };
      if (data.id !== id) return;
      cleanup();
      if (data.error) {
        reject(new Error(data.error.message ?? `${method} failed.`));
      } else {
        resolve(data.result as T);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out calling Chrome DevTools ${method}.`));
    }, 5_000);
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method }));
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Browser debugging endpoint failed with HTTP ${res.status}.`,
    );
  }
  return res.json();
}

async function cleanupActiveSession(): Promise<void> {
  const session = activeSession;
  activeSession = null;
  if (!session) return;

  session.browser.kill();
  await rm(session.userDataDir, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
