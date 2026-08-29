# Phase Report Template

The report a phase ends with. **15 sections, not 40.** Fill each in a few lines.
Do not retell the implementation story — the commits and the code carry that.
If a section does not apply, write "n/a" and why; do not delete it.

---

## Q\<n\> REPORT

**1. Verdict**
`Q<n> PASS — READY FOR Q<n+1>` | `Q<n> NEEDS FIX` | `Q<n> BLOCKED`

**2. Commits**
Starting commit → final commit.

**3. Migration status**
Range applied, any new migration, post-apply check result (e.g. 17/17).
Confirm applied migrations were not edited.

**4. Key implementation and security findings**
What actually changed and which invariant it touches. Bullets, not prose.

**5. Focused test totals**
Suites run for the changed area, pass/fail counts.

**6. Full regression total**
`npm run test:all` — tests / pass / fail.

**7. Mutation total**
`npm run test:mutations` — killed / survived. Any survivor is a finding, not a pass.

**8. TypeScript / ESLint / build**
Three results, one line each.

**9. Deployment version**
Worker version id now serving.

**10. Desktop QA**
Screens checked and what was observed. Naming the screens is the evidence.

**11. Mobile QA**
Same, at a phone viewport.

**12. Protected fingerprint**
Pre-deploy vs post-QA counts. Unchanged, or explained.

**13. Cross-Area integrity**
Confirmation that Area scoping, the write barrier and birthday privacy still hold.

**14. Remaining risks**
Anything known and accepted, anything deferred.

**15. Handoff**
`docs/CURRENT-STATE.md` updated, then the final line:

`CLEAR THIS CLAUDE CHAT NOW. START Q<n+1> IN A FRESH SESSION.`
