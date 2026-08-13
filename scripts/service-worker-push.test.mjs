import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * Runs the real `public/sw.js` and exercises its handlers.
 *
 * The static checks in `notification-security.test.mjs` prove the handlers are
 * present and that they leave the cache alone; these prove they behave. A
 * service worker cannot be imported — it expects a `ServiceWorkerGlobalScope` —
 * so the file is evaluated in a VM against a stand-in `self` that records what
 * the worker asks the browser to do.
 *
 * This is the only place a notification tap is exercised end to end, and a
 * broken tap is invisible until someone taps one on a phone.
 */

const ORIGIN = "https://xmas-family.uk";

/** Loads sw.js against a fake global and returns its listeners plus a log. */
function loadServiceWorker({ windowClients = [] } = {}) {
  const shown = [];
  const opened = [];
  const listeners = new Map();

  const clients = windowClients.map((url) => ({
    url,
    focused: false,
    navigatedTo: null,
    focus() {
      this.focused = true;
      return Promise.resolve(this);
    },
    navigate(target) {
      this.navigatedTo = target;
      return Promise.resolve(this);
    },
  }));

  const self = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    location: new URL(ORIGIN),
    registration: {
      showNotification: (title, options) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(clients),
      openWindow: (url) => {
        opened.push(url);
        return Promise.resolve({ url });
      },
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => Promise.resolve(),
  };

  const context = vm.createContext({
    self,
    // The worker only reaches for these on install/activate/fetch, which this
    // harness never dispatches — but they must exist for evaluation.
    caches: { open: async () => ({ put: async () => {} }), keys: async () => [], match: async () => undefined, delete: async () => true },
    fetch: async () => new Response(""),
    Response,
    URL,
    console,
  });

  vm.runInContext(readFileSync(join(process.cwd(), "public", "sw.js"), "utf8"), context);
  return { listeners, shown, opened, clients };
}

/** Dispatches a push event and waits for whatever the handler passed to waitUntil. */
async function dispatchPush(worker, payload) {
  const pending = [];
  worker.listeners.get("push")({
    data: payload === undefined ? null : { json: () => JSON.parse(payload) },
    waitUntil: (promise) => pending.push(promise),
  });
  await Promise.all(pending);
}

async function dispatchClick(worker, notification) {
  const pending = [];
  let closed = false;
  worker.listeners.get("notificationclick")({
    notification: { ...notification, close: () => { closed = true; } },
    waitUntil: (promise) => pending.push(promise),
  });
  await Promise.all(pending);
  return closed;
}

test("the worker registers push handling alongside its existing lifecycle handlers", () => {
  const worker = loadServiceWorker();

  // Adding push must not have displaced any of the PWA behaviour.
  for (const type of ["install", "activate", "fetch", "push", "notificationclick"]) {
    assert.equal(typeof worker.listeners.get(type), "function", `${type} handler must exist`);
  }
});

test("a push renders the notification the server sent", async () => {
  const worker = loadServiceWorker();
  await dispatchPush(worker, JSON.stringify({
    title: "🎁 New purchase for Mum",
    body: "Jade added £24.99 of gifts for Mum.",
    url: "/people?person=abc",
    tag: "purchase:abc",
  }));

  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].title, "🎁 New purchase for Mum");
  assert.equal(worker.shown[0].options.body, "Jade added £24.99 of gifts for Mum.");
  assert.equal(worker.shown[0].options.tag, "purchase:abc");
  assert.equal(worker.shown[0].options.data.url, "/people?person=abc");
  // Repeats replace rather than re-alert.
  assert.equal(worker.shown[0].options.renotify, false);
  assert.match(worker.shown[0].options.badge, /badge-96\.png$/);
});

test("a malformed or empty push still shows something", async () => {
  // Chrome and Firefox display their own "site updated in the background"
  // notice if a push handler finishes without calling showNotification, which
  // reads to a user as a bug in the app.
  for (const payload of [undefined, "{not json"]) {
    const worker = loadServiceWorker();
    await dispatchPush(worker, payload);
    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0].title, "Christmas Budget");
    assert.equal(worker.shown[0].options.data.url, "/");
  }
});

test("a push cannot send the app to another origin", async () => {
  const worker = loadServiceWorker();
  // A payload is server-generated, but the worker is the last line of defence:
  // anything that is not an in-app path falls back to the home route.
  for (const url of ["https://evil.example.com/steal", "//evil.example.com", "javascript:alert(1)"]) {
    worker.shown.length = 0;
    await dispatchPush(worker, JSON.stringify({ title: "t", url }));
    assert.equal(worker.shown[0].options.data.url, "/", `${url} must not be opened`);
  }
});

test("tapping a notification focuses the app that is already open and navigates it", async () => {
  const worker = loadServiceWorker({ windowClients: [`${ORIGIN}/people`] });
  const closed = await dispatchClick(worker, { data: { url: "/owed" } });

  assert.equal(closed, true, "the notification is dismissed on tap");
  assert.equal(worker.clients[0].focused, true, "the open window is focused, not duplicated");
  assert.equal(worker.clients[0].navigatedTo, `${ORIGIN}/owed`);
  assert.deepEqual(worker.opened, [], "no second window is opened");
});

test("tapping with nothing open launches the app at the right route", async () => {
  const worker = loadServiceWorker({ windowClients: [] });
  await dispatchClick(worker, { data: { url: "/people?person=abc" } });

  assert.deepEqual(worker.opened, [`${ORIGIN}/people?person=abc`]);
});

test("a window from another origin is never focused or navigated", async () => {
  const worker = loadServiceWorker({ windowClients: ["https://mail.example.com/inbox"] });
  await dispatchClick(worker, { data: { url: "/owed" } });

  assert.equal(worker.clients[0].focused, false);
  assert.equal(worker.clients[0].navigatedTo, null);
  assert.deepEqual(worker.opened, [`${ORIGIN}/owed`], "a fresh app window opens instead");
});

test("each notification type lands on its stated route", async () => {
  // The routes named in the settings copy and in notification-content.ts.
  for (const [url, expected] of [
    ["/owed", `${ORIGIN}/owed`],
    ["/people?person=recipient-1", `${ORIGIN}/people?person=recipient-1`],
  ]) {
    const worker = loadServiceWorker({ windowClients: [] });
    await dispatchClick(worker, { data: { url } });
    assert.deepEqual(worker.opened, [expected]);
  }
});

test("a notification with no data still opens the app rather than failing", async () => {
  const worker = loadServiceWorker({ windowClients: [] });
  await dispatchClick(worker, {});

  assert.deepEqual(worker.opened, [`${ORIGIN}/`]);
});
