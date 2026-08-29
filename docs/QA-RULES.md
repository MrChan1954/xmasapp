# QA Rules

QA runs against the **live** application and the **live** database. There is no
separate QA environment. Everything below exists because the safety net of "it's
only a test copy" does not exist here.

## Where QA runs

- **URL:** `https://xmas-family.uk` — never localhost. Browser tooling is only
  permissioned for that domain.
- **Browser:** Microsoft Edge. Drive it with Playwright channel `msedge`.
- **Database:** the same Supabase project the family uses, in synthetic Areas.

## The protected-data rule

`.qa-areas.local.json` (repo root, git-ignored, **never commit**) names:

| Key | Meaning |
| --- | ------- |
| `protectedAreaIds`  | the real family. QA refuses every write here. |
| `protectedEventIds` | the real Christmas and anything else untouchable. |
| `qaAreaIds`         | the synthetic Areas QA may write to. |

`scripts/qa/protected.mjs` is the guard. It **fails closed**: a missing config, an
unparseable one, or an unknown id all refuse. While `qaAreaIds` is empty every QA
write is refused — that is the correct state, not a bug.

The guard can only refuse. It grants nothing and authorises nothing; product
authorisation stays in RLS, the write barrier and the definer routines.

## What QA must never do

- Write, update or delete anything in a protected Area or event.
- Commit `.qa-areas.local.json`.
- Make the product aware that QA exists. `scripts/qa/no-product-coupling.test.mjs`
  proves the product does not import the guard and does not know a protected id
  exists. A QA Area must be exactly as isolated as a real one.
- Use the service role without an explicit Area filter. It bypasses RLS *and* the
  write barrier, so a stray write lands silently with nothing able to refuse it.
- Run destructive SQL against production to "check" something. Read instead.

## Fingerprinting

`scripts/qa/fingerprint.mjs` takes a **read-only** count-based fingerprint of the
real family's data. Take it **before** deploying and **again after** live QA, then
compare. The question "did QA touch anything real?" is then answered by the
database rather than from recollection.

Every request in that file is a GET. It uses the service role because counting
across Areas requires seeing across them — which is exactly why it must never
gain a write.

## The QA gates

| Command | Proves |
| ------- | ------ |
| `npm run test:qa-guard`     | the guard refuses correctly and the product is not coupled to it |
| `npm run test:qa-readiness` | the tenant config is present and sane before QA starts |

## Browser QA checklist

Run both, on the live site, signed in as a real member:

1. **Desktop** — the phase's changed screens, plus navigation chrome and the
   Area switcher.
2. **Mobile** — the same, at a phone viewport. Bottom tabs and the icon rail
   behave differently and have regressed independently before.

Record what was checked, not merely that it was. A phase report that says "QA
passed" without naming the screens is not evidence.

## After QA

1. Re-take the fingerprint and compare with the pre-deploy one.
2. Confirm no protected row count changed.
3. Record the deployed Worker version id in `docs/CURRENT-STATE.md`.

If a fingerprint differs and you cannot explain the difference, treat it as a
protected-data incident: stop, report it, and do not continue the phase.
