/**
 * A real DOM to render into, and accessibility-shaped ways to ask about it.
 *
 * The queries below deliberately look things up the way an assistive
 * technology would — by ROLE and ACCESSIBLE NAME — rather than by class or tag.
 * That is the whole point of this file: a test that says "the dialog's confirm
 * button is disabled while saving" keeps meaning the same thing after the
 * markup underneath is rewritten, which is exactly what happened to this app
 * when it moved onto shadcn.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "https://xmas-family.uk/",
});

const { window } = dom;

/* --- What Radix needs that jsdom does not implement --------------------- */
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.DOMRect) {
  window.DOMRect = class {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
    }
  };
}
for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture", "scrollIntoView"]) {
  if (!window.Element.prototype[method]) window.Element.prototype[method] = function () {};
}
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}

/*
 * Fill in the DOM half of the global object from jsdom, and ONLY the half
 * Node does not already provide.
 *
 * Copying the whole window surface looks tidier and is a trap: jsdom's
 * `window.queueMicrotask` delegates to the global one, so overwriting the
 * global with jsdom's makes it call itself until the stack runs out. The same
 * goes for the timers. Node's versions are the right ones; what is missing is
 * everything DOM — including the pieces a shortlist keeps forgetting,
 * MutationObserver for Radix's focus scope and HTMLFormElement for its switch.
 */
for (const key of Object.getOwnPropertyNames(window)) {
  if (key === "undefined" || key.startsWith("_")) continue;
  if (key in globalThis) continue;
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (!descriptor) continue;
  try {
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
  } catch {
    // A handful refuse redefinition; those are already correct.
  }
}

/*
 * These DO exist on the Node global and must still come from jsdom.
 *
 * The event classes are the subtle half. Node 24 has its own CustomEvent, and
 * Radix's dismissable layer constructs one to announce that a layer opened —
 * so with Node's class winning, jsdom rejects the dispatch outright with
 * "parameter 1 is not of type Event". Anything dispatched at a jsdom node has
 * to be built from jsdom's constructors.
 */
for (const key of [
  "window", "document", "navigator", "location",
  "Event", "CustomEvent", "EventTarget", "UIEvent", "MouseEvent",
  "KeyboardEvent", "PointerEvent", "FocusEvent", "InputEvent",
]) {
  const value = key === "window" ? window : window[key];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

/** Render an element into a fresh container and return helpers over it. */
export async function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let unmounted = false;
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    async update(next) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export { React, act };

/* --- Accessible queries -------------------------------------------------- */

const IMPLICIT_ROLES = {
  BUTTON: "button",
  A: "link",
  INPUT: "textbox",
  TEXTAREA: "textbox",
  SELECT: "combobox",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  TABLE: "table",
  TD: "cell",
  TH: "columnheader",
  TR: "row",
};

function roleOf(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  if (element.tagName === "INPUT") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit") return "button";
    return "textbox";
  }
  return IMPLICIT_ROLES[element.tagName] ?? null;
}

/** The accessible name, by the parts of the algorithm this app actually uses. */
export function accessibleName(element) {
  const label = element.getAttribute("aria-label");
  if (label) return label.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  }

  // A wrapping <label>, which is how this app's Field associates its controls.
  const wrapping = element.closest("label");
  if (wrapping) return wrapping.textContent.trim();

  const id = element.getAttribute("id");
  if (id) {
    const forLabel = element.ownerDocument.querySelector(`label[for="${id}"]`);
    if (forLabel) return forLabel.textContent.trim();
  }

  return element.textContent.trim();
}

/**
 * Scoped to `scope` — pass a container to search one render, or document.body
 * to search a portalled dialog. Searching the whole document by default made
 * one test find another test's still-mounted button, which is a very quiet way
 * to make a suite lie.
 */
export function allByRole(scope, role) {
  const within = [...scope.querySelectorAll("*")];
  if (roleOf(scope) === role) within.unshift(scope);
  return within.filter((element) => roleOf(element) === role);
}

export function byRole(scope, role, name) {
  const matches = allByRole(scope, role).filter(
    (element) => name === undefined || accessibleName(element).includes(name),
  );
  if (matches.length === 0) {
    throw new Error(`no element with role "${role}"${name ? ` named "${name}"` : ""}`);
  }
  return matches[0];
}

export function queryByRole(scope, role, name) {
  try {
    return byRole(scope, role, name);
  } catch {
    return null;
  }
}

/* --- Interaction --------------------------------------------------------- */

export async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export async function pressKey(target, key) {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

export async function changeValue(element, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : element instanceof window.HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
