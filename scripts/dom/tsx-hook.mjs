/**
 * A module-resolution hook that lets `node --test` import the app's real
 * components.
 *
 * Node 24 strips TypeScript types on its own, but it does not transform JSX, so
 * a `.tsx` file cannot be imported directly. esbuild does that one job here.
 *
 * This exists so the shadcn regression suite can RENDER the primitives and
 * assert on roles, names and behaviour, rather than reading the source and
 * hoping the markup means what it looks like. Every other test file in this
 * repository is unaffected — the hook only claims `.tsx`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { transform } from "esbuild";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Modules replaced for the DOM suite.
 *
 * A stub only bites when a test imports something that reaches it, so this map
 * is not as broad as it looks: `next/link` is here because Next resolves it
 * through its bundler rather than plain Node, and the four below are here so
 * `FamilyProvider` -- the global Area/event context -- can be RENDERED against
 * a fixture instead of a network. Nothing else in the repository imports them
 * from a test.
 *
 * The Supabase stub deliberately does no scoping of its own; see the comment in
 * that file for why that is the whole point.
 */
const STUBS = new Map([
  ["next/link", "scripts/dom/stubs/next-link.mjs"],
  ["next/navigation", "scripts/dom/stubs/next-navigation.mjs"],
  ["@/utils/supabase/client", "scripts/dom/stubs/supabase-client.mjs"],
  ["@/utils/supabase/current-member-client", "scripts/dom/stubs/current-member-client.mjs"],
  ["@/utils/supabase/area-choice-client", "scripts/dom/stubs/area-choice-client.mjs"],
]);

const EXTENSIONS = [".tsx", ".ts", ".mjs", ".js", "/index.tsx", "/index.ts"];

/** Try the extensionless specifier, then each extension this codebase uses. */
async function resolveWithExtensions(href, context, nextResolve) {
  try {
    return await nextResolve(href, context);
  } catch (error) {
    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(href + extension, context);
      } catch {
        // try the next shape
      }
    }
    throw error;
  }
}

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier);
  if (stub) return nextResolve(pathToFileURL(resolvePath(ROOT, stub)).href, context);

  // `@/x` is the app's alias for `src/x`; esbuild does no resolution itself.
  if (specifier.startsWith("@/")) {
    const href = pathToFileURL(resolvePath(ROOT, "src", specifier.slice(2))).href;
    return resolveWithExtensions(href, context, nextResolve);
  }

  if (specifier.startsWith(".") && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(base.pathname)) {
      return resolveWithExtensions(base.href, context, nextResolve);
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".tsx")) return nextLoad(url, context);

  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const { code } = await transform(source, {
    loader: "tsx",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    sourcefile: path,
  });

  return { format: "module", shortCircuit: true, source: code };
}
