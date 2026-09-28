import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const LOGIN_URL = "https://www.playstation.com/";
const CDP_TIMEOUT_MS = 5_000;

interface BrowserLoginSession {
  browser: ChildProcess;
  port: number;
  userDataDir: string;
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
      await fetchJson(
        `http://127.0.0.1:${port}/json/version`,
        Math.min(CDP_TIMEOUT_MS, deadline - Date.now()),
      );
      return;
    } catch {
      // Browser is still starting.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the browser debugging endpoint.");
}

async function readNpssoCookie(port: number): Promise<string | null> {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  if (
    !isRecord(version) ||
    typeof version.webSocketDebuggerUrl !== "string" ||
    !version.webSocketDebuggerUrl.trim()
  ) {
    throw new Error("Could not find the browser debugging target.");
  }

  const socket = await openCdpSocket(version.webSocketDebuggerUrl);
  try {
    // Read the default context's cookies through the browser target so this
    // does not depend on an individual page responding to Storage commands.
    const response = await sendCdp(socket, "Storage.getCookies");
    if (!isRecord(response) || !Array.isArray(response.cookies)) {
      throw new Error("Chrome DevTools returned an invalid cookie list.");
    }
    for (const cookie of response.cookies) {
      if (
        isRecord(cookie) &&
        typeof cookie.name === "string" &&
        cookie.name.toLowerCase() === "npsso" &&
        typeof cookie.value === "string" &&
        cookie.value
      ) {
        return cookie.value;
      }
    }
    return null;
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
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError: CdpListener = (event) =>
        fail(
          event.error ??
            new Error("Chrome DevTools WebSocket connection failed."),
        );
      const onClose = () =>
        fail(new Error("Chrome DevTools WebSocket closed before connecting."));
      const timeout = setTimeout(
        () => fail(new Error("Timed out connecting to Chrome DevTools.")),
        CDP_TIMEOUT_MS,
      );
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return socket;
}

async function sendCdp(socket: CdpSocket, method: string): Promise<unknown> {
  // Chrome requires a signed 32-bit command ID, not any JS safe integer.
  const id = Math.floor(Math.random() * 0x7fffffff);
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onMessage: CdpListener = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        fail(new Error(`Invalid Chrome DevTools response to ${method}.`));
        return;
      }
      if (!isRecord(data)) {
        fail(new Error(`Invalid Chrome DevTools response to ${method}.`));
        return;
      }
      // Ignore notifications and other commands' replies, but surface protocol
      // errors that Chrome cannot associate with a valid command ID.
      if (data.id !== id && !(data.id === undefined && "error" in data)) return;
      cleanup();
      if ("error" in data) {
        const message =
          isRecord(data.error) && typeof data.error.message === "string"
            ? data.error.message
            : `${method} failed.`;
        reject(new Error(message));
      } else if (!("result" in data)) {
        reject(new Error(`Invalid Chrome DevTools response to ${method}.`));
      } else {
        resolve(data.result);
      }
    };
    const onError: CdpListener = (event) =>
      fail(
        event.error ??
          new Error(`Chrome DevTools WebSocket failed calling ${method}.`),
      );
    const onClose = () =>
      fail(
        new Error(`Chrome DevTools WebSocket closed while calling ${method}.`),
      );
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out calling Chrome DevTools ${method}.`));
    }, CDP_TIMEOUT_MS);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    try {
      socket.send(JSON.stringify({ id, method }));
    } catch (error) {
      fail(error);
    }
  });
}

async function fetchJson(
  url: string,
  timeoutMs = CDP_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `Browser debugging endpoint failed with HTTP ${res.status}.`,
      );
    }
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Timed out contacting the browser debugging endpoint.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function cleanupActiveSession(): Promise<void> {
  const session = activeSession;
  activeSession = null;
  if (!session) return;

  session.browser.kill();
  // Chrome can still write profile files briefly after receiving the signal.
  await rm(session.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
