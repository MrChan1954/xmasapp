import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /*
     * THE CLOUDFLARE BUILD OUTPUT.
     *
     * `opennextjs-cloudflare build` writes a bundled copy of the whole
     * application -- minified chunks, the Worker entry, vendored `next`
     * internals -- into `.open-next/`. Git ignores it. ESLint did not, so the
     * moment anybody ran a deploy build, `npm run lint` started reporting
     * thousands of problems in generated code.
     *
     * THAT IS WORSE THAN NOISE. A lint gate that fails for reasons nobody
     * caused is a gate people stop reading, and a real error in `src/` is then
     * one line among nineteen thousand. Found when a post-deploy lint run
     * reported 1,389 errors and every single one was in `.open-next/`.
     */
    ".open-next/**",
    /*
     * AND WRANGLER'S SCRATCH DIRECTORY, for exactly the same reason.
     *
     * `wrangler dev` and `wrangler deploy --dry-run` each write a bundled
     * `worker.js` and a middleware facade into `.wrangler/tmp/<random>/`. Git
     * ignores `.wrangler/`; ESLint did not. So the gate passed on a clean
     * checkout and failed the moment anybody previewed the Worker or ran
     * `npm run check:worker-bundle` -- 21,456 lines of problems, every one of
     * them in a generated bundle, and a real error in `src/` invisible among
     * them. Found in Q9, when verifying a cache header against a local Worker
     * turned the next lint run red.
     */
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
