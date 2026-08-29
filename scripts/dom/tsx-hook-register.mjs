/**
 * Registers the JSX/TSX module hook for the DOM suite.
 *
 * `node --test` loads this with `--import`, which runs it before any test file
 * is resolved — which is what makes `import ... from "../src/app/.../ui/index.tsx"`
 * work at all.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsx-hook.mjs", pathToFileURL(import.meta.filename));
