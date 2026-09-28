import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import {
  beginBrowserLogin,
  cancelBrowserLogin,
  completeBrowserLogin,
  hasActiveBrowserLogin,
} from "../psn/browser-login.js";

const originalBrowserPath = process.env.PSN_BROWSER_PATH;
const realWebSocket = globalThis.WebSocket;

afterEach(async () => {
  await cancelBrowserLogin();
  mock.restoreAll();
  syncBuiltinESMExports();
  globalThis.WebSocket = realWebSocket;
  if (originalBrowserPath === undefined) {
    delete process.env.PSN_BROWSER_PATH;
  } else {
    process.env.PSN_BROWSER_PATH = originalBrowserPath;
  }
});

function mockBrowser(
  options: {
    connection?: "open" | "close" | "error" | "silent";
    onSend?: (socket: EventTarget, id: number) => void;
    random?: number;
  } = {},
) {
  mock.method(Math, "random", () => options.random ?? 0.5);
  const browser = new childProcess.ChildProcess();
  mock.method(browser, "unref", () => {});
  const kill = mock.method(browser, "kill", () => true);
  let userDataDir = "";
  mock.method(
    childProcess,
    "spawn",
    (_file: string, args: readonly string[]) => {
      assert.ok(Array.isArray(args));
      userDataDir = args
        .find((arg) => arg.startsWith("--user-data-dir="))!
        .slice("--user-data-dir=".length);
      return browser;
    },
  );
  syncBuiltinESMExports();
  process.env.PSN_BROWSER_PATH = process.execPath;

  const browserUrl = "ws://127.0.0.1/devtools/browser/test-browser";
  const pageUrl = "ws://127.0.0.1/devtools/page/test-page";
  const paths: string[] = [];
  let version: unknown = { webSocketDebuggerUrl: browserUrl };
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input));
    paths.push(pathname);
    if (pathname === "/json/version") return Response.json(version);
    assert.equal(pathname, "/json/list");
    return Response.json([{ type: "page", webSocketDebuggerUrl: pageUrl }]);
  });

  let cookies: unknown[] = [{ name: "NPSSO", value: "test-npsso" }];
  let cdpError: string | undefined;
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    closed = false;

    constructor(readonly url: string) {
      super();
      sockets.push(this);
      if (options.connection !== "silent") {
        queueMicrotask(() =>
          this.dispatchEvent(new Event(options.connection ?? "open")),
        );
      }
    }

    send(data: string) {
      const { id, method } = JSON.parse(data);
      assert.equal(method, "Storage.getCookies");
      if (options.onSend) {
        options.onSend(this, id);
        return;
      }
      // Chrome rejects IDs outside the signed 32-bit range without echoing an ID.
      if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff) {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                error: {
                  code: -32600,
                  message: "Message must have integer 'id' property",
                },
              }),
            }),
          ),
        );
        return;
      }
      const response = cdpError
        ? { id, error: { message: cdpError } }
        : { id, result: { cookies } };
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(response) }),
        ),
      );
    }

    close() {
      this.closed = true;
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

  return {
    browserUrl,
    paths,
    sockets,
    kill,
    get userDataDir() {
      return userDataDir;
    },
    setCookies(value: typeof cookies) {
      cookies = value;
    },
    setVersion(value: unknown) {
      version = value;
    },
    setCdpError(value: string) {
      cdpError = value;
    },
  };
}

function assertSocketCleanedUp(socket: EventTarget & { closed: boolean }) {
  assert.equal(socket.closed, true);
  for (const event of ["open", "message", "close", "error"]) {
    assert.equal(
      getEventListeners(socket, event).length,
      0,
      `${event} listeners`,
    );
  }
}

function reply(socket: EventTarget, data: unknown) {
  queueMicrotask(() =>
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(data),
      }),
    ),
  );
}

test("browser login uses Chrome-compatible command IDs on the browser target and cleans up", async () => {
  const browser = mockBrowser();
  await beginBrowserLogin();
  assert.equal(hasActiveBrowserLogin(), true);
  assert.equal(existsSync(browser.userDataDir), true);

  assert.deepEqual(await completeBrowserLogin(), { npsso: "test-npsso" });
  assert.deepEqual(browser.paths, ["/json/version", "/json/version"]);
  assert.equal(browser.sockets[0].url, browser.browserUrl);
  assertSocketCleanedUp(browser.sockets[0]);
  assert.equal(hasActiveBrowserLogin(), false);
  assert.equal(browser.kill.mock.callCount(), 1);
  assert.equal(existsSync(browser.userDataDir), false);
});

test("browser login surfaces protocol errors without a command ID", async (t) => {
  const browser = mockBrowser({
    onSend(socket) {
      queueMicrotask(() =>
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              error: {
                code: -32600,
                message: "Message must have integer 'id' property",
              },
            }),
          }),
        ),
      );
    },
  });
  await beginBrowserLogin();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = assert.rejects(
    completeBrowserLogin(),
    /Message must have integer 'id' property/,
  );
  await setImmediate();
  t.mock.timers.tick(5_000);
  await result;
  assert.equal(browser.sockets[0].closed, true);
  assert.equal(hasActiveBrowserLogin(), true);
});

test("browser login fails promptly when the command socket closes", async (t) => {
  const browser = mockBrowser({
    onSend(socket) {
      queueMicrotask(() => socket.dispatchEvent(new Event("close")));
    },
  });
  await beginBrowserLogin();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = assert.rejects(
    completeBrowserLogin(),
    /WebSocket closed.*Storage.getCookies/,
  );
  await setImmediate();
  t.mock.timers.tick(5_000);
  await result;
  assert.equal(browser.sockets[0].closed, true);
});

test("browser login bounds the WebSocket handshake and closes a stalled socket", async (t) => {
  const browser = mockBrowser({ connection: "silent" });
  await beginBrowserLogin();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failure: unknown;
  const result = completeBrowserLogin().catch((error) => {
    failure = error;
  });
  await setImmediate();
  t.mock.timers.tick(5_000);
  await setImmediate();
  try {
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /Timed out connecting to Chrome DevTools/);
    assert.equal(browser.sockets[0].closed, true);
  } finally {
    browser.sockets[0].dispatchEvent(new Event("error"));
    await result;
  }
});

test("browser login keeps the session open until an NPSSO cookie is available", async () => {
  const browser = mockBrowser();
  browser.setCookies([
    { name: "other-cookie", value: "unrelated" },
    { name: "npsso", value: "" },
  ]);
  await beginBrowserLogin();

  await assert.rejects(
    completeBrowserLogin(),
    /Could not find an NPSSO cookie yet/,
  );
  assert.equal(browser.sockets[0].closed, true);
  assert.equal(hasActiveBrowserLogin(), true);
  assert.equal(browser.kill.mock.callCount(), 0);
  assert.equal(existsSync(browser.userDataDir), true);

  browser.setCookies([{ name: "npsso", value: "test-npsso" }]);
  assert.deepEqual(await completeBrowserLogin(), { npsso: "test-npsso" });
  assert.equal(browser.sockets[1].closed, true);
  assert.equal(hasActiveBrowserLogin(), false);
});

test("browser login reports a missing browser WebSocket URL", async () => {
  const browser = mockBrowser();
  await beginBrowserLogin();

  for (const version of [
    null,
    {},
    { webSocketDebuggerUrl: 123 },
    { webSocketDebuggerUrl: " " },
  ]) {
    browser.setVersion(version);
    await assert.rejects(
      completeBrowserLogin(),
      /Could not find the browser debugging target/,
    );
  }
  assert.equal(browser.sockets.length, 0);
  assert.equal(hasActiveBrowserLogin(), true);
});

test("browser login closes its socket after a CDP error and allows retry", async () => {
  const browser = mockBrowser();
  browser.setCdpError("Cookie access failed");
  await beginBrowserLogin();

  await assert.rejects(completeBrowserLogin(), /Cookie access failed/);
  assert.equal(browser.sockets[0].closed, true);
  assert.equal(hasActiveBrowserLogin(), true);
  assert.equal(browser.kill.mock.callCount(), 0);

  browser.setCdpError("");
  assert.deepEqual(await completeBrowserLogin(), { npsso: "test-npsso" });
});

for (const random of [0, 1 - Number.EPSILON]) {
  test(`browser login uses valid command IDs at random boundary ${random}`, async () => {
    const browser = mockBrowser({ random });
    await beginBrowserLogin();
    assert.deepEqual(await completeBrowserLogin(), { npsso: "test-npsso" });
    assertSocketCleanedUp(browser.sockets[0]);
  });
}

for (const connection of ["close", "error"] as const) {
  test(`browser login cleans up when a handshake receives ${connection}`, async () => {
    const browser = mockBrowser({ connection });
    await beginBrowserLogin();
    await assert.rejects(completeBrowserLogin(), /Chrome DevTools WebSocket/);
    assertSocketCleanedUp(browser.sockets[0]);
    assert.equal(hasActiveBrowserLogin(), true);
  });
}

for (const failure of ["error event", "send throws"] as const) {
  test(`browser login cleans up after a command ${failure}`, async () => {
    const browser = mockBrowser({
      onSend(socket) {
        if (failure === "send throws") throw new Error("Socket send failed");
        queueMicrotask(() => socket.dispatchEvent(new Event("error")));
      },
    });
    await beginBrowserLogin();
    await assert.rejects(completeBrowserLogin(), /failed/i);
    assertSocketCleanedUp(browser.sockets[0]);
    assert.equal(hasActiveBrowserLogin(), true);
  });
}

test("browser login times out an unanswered command and removes its listeners", async (t) => {
  const browser = mockBrowser({ onSend() {} });
  await beginBrowserLogin();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = assert.rejects(
    completeBrowserLogin(),
    /Timed out calling Chrome DevTools Storage.getCookies/,
  );
  await setImmediate();
  t.mock.timers.tick(5_000);
  await result;
  assertSocketCleanedUp(browser.sockets[0]);
  assert.equal(hasActiveBrowserLogin(), true);
});

test("browser login rejects malformed protocol responses without uncaught exceptions", async () => {
  let message = (_id: number) => "invalid JSON";
  const browser = mockBrowser({
    onSend(socket, id) {
      queueMicrotask(() =>
        socket.dispatchEvent(
          new MessageEvent("message", { data: message(id) }),
        ),
      );
    },
  });
  await beginBrowserLogin();
  for (message of [
    () => "invalid JSON",
    () => "null",
    () => "[]",
    (id: number) => JSON.stringify({ id }),
  ]) {
    await assert.rejects(
      completeBrowserLogin(),
      /Invalid Chrome DevTools response/,
    );
    assertSocketCleanedUp(browser.sockets.at(-1)!);
  }
});

test("browser login validates cookie lists and skips malformed cookies", async () => {
  let result: unknown;
  const browser = mockBrowser({
    onSend(socket, id) {
      reply(socket, { id, result });
    },
  });
  await beginBrowserLogin();
  for (result of [null, {}, { cookies: null }, { cookies: "invalid" }]) {
    await assert.rejects(completeBrowserLogin(), /invalid cookie list/);
    assertSocketCleanedUp(browser.sockets.at(-1)!);
  }
  result = {
    cookies: [
      null,
      {},
      { name: 123, value: "wrong" },
      { name: "npsso", value: 123 },
      { name: "npsso", value: "" },
      { name: "NPSSO", value: "test-npsso" },
    ],
  };
  assert.deepEqual(await completeBrowserLogin(), { npsso: "test-npsso" });
  assertSocketCleanedUp(browser.sockets.at(-1)!);
});

test("browser login ignores notifications and responses to other commands", async () => {
  const browser = mockBrowser({
    onSend(socket, id) {
      reply(socket, { method: "Target.targetCreated", params: {} });
      reply(socket, { id: id + 1, error: { message: "Unrelated failure" } });
      reply(socket, {
        id,
        result: { cookies: [{ name: "npsso", value: "test-npsso" }] },
      });
    },
  });
  await beginBrowserLogin();
  assert.deepEqual(await completeBrowserLogin(), { npsso: "test-npsso" });
  assertSocketCleanedUp(browser.sockets[0]);
});

for (const stalled of ["headers", "body"] as const) {
  test(`browser login bounds debugger HTTP ${stalled} waits`, async (t) => {
    const browser = mockBrowser();
    await beginBrowserLogin();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal: AbortSignal | undefined;
    mock.method(
      globalThis,
      "fetch",
      async (_input: unknown, init?: RequestInit) => {
        assert.ok(init?.signal);
        signal = init.signal;
        if (stalled === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            });
          });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              signal!.addEventListener(
                "abort",
                () => controller.error(signal!.reason),
                { once: true },
              );
            },
          }),
        );
      },
    );
    const result = assert.rejects(
      completeBrowserLogin(),
      /Timed out contacting the browser debugging endpoint/,
    );
    await setImmediate();
    t.mock.timers.tick(5_000);
    await result;
    assert.equal(signal?.aborted, true);
    assert.equal(browser.sockets.length, 0);
    assert.equal(hasActiveBrowserLogin(), true);
  });
}

test("browser login keeps its startup deadline when debugger requests stall", async (t) => {
  const browser = mockBrowser();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let notifyRequested = () => {};
  const requested = new Promise<void>((resolve) => {
    notifyRequested = resolve;
  });
  mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      assert.ok(init?.signal);
      const signal = init.signal;
      notifyRequested();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  const result = assert.rejects(
    beginBrowserLogin(),
    /Timed out waiting for the browser debugging endpoint/,
  );
  await requested;
  for (let second = 0; second < 11; second++) {
    t.mock.timers.tick(1_000);
    await setImmediate();
  }
  await result;
  assert.equal(browser.kill.mock.callCount(), 1);
  assert.equal(hasActiveBrowserLogin(), false);
  assert.equal(existsSync(browser.userDataDir), false);
});
