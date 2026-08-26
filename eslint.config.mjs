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
  ]),
]);

export default eslintConfig;
