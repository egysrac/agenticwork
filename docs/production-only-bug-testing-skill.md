---
name: production-only-bug-testing
description: Use when a bug or change touches stateful dependencies (server lifecycle, files), external systems (IMAP, tmux, child processes), or timing assumptions — i.e. anything that "test passes locally but breaks in prod". Trigger phrases: "production-only bug", "works on my machine", "miért nem fogta meg a teszt", "test passes but prod fails", "csak élesben jön elő", "stateful dependency", "external system", "race condition tesztelés".
type: skill
---

# Production-Only Bug Testing

A unit test that passes doesn't mean the code works. Production-only bugs are bugs that **only manifest under conditions the unit test doesn't replicate** — stateful dependencies, external systems, timing. Three concrete examples from this codebase (2026-08-26, BGPMODE826/GMAILENV826):

1. **gmail-api.ts envelope bug**: `isProtectedSender` compared a full `"Alice <alice@gmail.com>"` envelope against a bare address `alice@gmail.com` — never matched. The unit test for this function passed because it called the function directly with already-clean input. The REAL caller was `fetchEnvelopeFrom` → `decodeMimeHeader(env?.from)` which always produced envelope form. **The test never exercised the real call path.**

2. **background-tasks.ts env bug**: `-p` mode claude failed with "Not logged in" because ANTHROPIC_* env vars from `process.env` never reached the tmux session. Reason: tmux is client-server, and the new session inherits the **server's** env, frozen at server startup. Not from the spawning client. **No unit test could catch this — it requires a real tmux server that started before the dashboard, with a different env.**

3. **background-tasks.ts race condition**: Poller checked `isBgSessionAlive` before `captureSession`, so if the tmux session died between two poll cycles, the marker was lost (could only read from a live session). Worked ~50% of the time. **Synchronous unit tests can't reproduce timing-dependent behavior across processes.**

## The Three Pattern Categories

| Pattern | Example | Why unit tests miss it |
|---------|---------|------------------------|
| **Stateful dependencies** | tmux server lifecycle, file system state, database connections | Test creates a fresh state every run; prod has accumulated state |
| **External systems** | IMAP envelope format, child process spawning, network protocols | Mock hides the asymmetries (e.g. decoded vs raw input) |
| **Timing assumptions** | Polling intervals, race windows, sleeps, timeouts | Synchronous tests serialize everything; real time isn't tested |

## Recognition Checklist

Before writing code that touches any of the following, STOP and ask:

- [ ] Does this code depend on **state** created outside the current process? (long-running servers, queues, file system state, env vars set elsewhere)
- [ ] Does this code call **external systems** that have their own data shapes? (IMAP, SMTP, HTTP APIs, OS commands)
- [ ] Does this code make **timing assumptions** about other processes, intervals, or race windows?
- [ ] Is there a **contract pinning test** (a test that documents the contract) — does that contract match the actual code, or is the test locking in a wrong behavior?

If any of these is "yes" — the unit test you'll write WILL NOT catch the bug. Plan for integration testing or document a manual regression recipe.

## Testing Strategies by Pattern

### 1. Stateful dependencies

**Fix unit-test bias**: extract the stateful-touching logic into a small testable function, then unit-test the function. The actual stateful-touching code stays thin and is covered by a manual recipe.

Example: `buildModelEnv(env)` is a pure function. The actual `execFileSync(TMUX, ...)` call uses its output. Unit-test the pure function; document the manual recipe for the stateful part.

### 2. External systems

**Fix unit-test bias**: run the **full data transformation chain** end-to-end, from the external system's input shape to your function's input. Don't just test your function in isolation.

Example: the GMAILENV826 fix added a test that takes an IMAP envelope object (`{ name, address }`) → runs through `decodeMimeHeader` → runs through `isProtectedSender`. This catches asymmetries in the data flow that a direct call would miss.

If the external system can't be invoked in tests, at least:
- Construct the **exact input shape** the external system produces (from docs / captures)
- Walk the full chain in the test, asserting at each step
- Lock in the contract with a comment: "if this fails, the data shape from X changed"

### 3. Timing assumptions

**Fix unit-test bias**: structurally decouple the timing assumption. Don't sleep-and-pray; make the output persist in a way that doesn't depend on session lifecycle.

Example: the BGPMODE826 race was fixed by writing output to a **file** instead of reading from the tmux pane. The file persists regardless of session state. The poller now reads the file — no race window.

When you CAN'T structurally decouple:
- Document the timing assumption explicitly with the cycle numbers (`poll = 10s, sleep = 60s = 6 cycles — if cycle < 1, marker is missed`)
- Add a **manual regression test recipe** in the test file's comments
- Add a runtime assertion that warns if the assumption breaks (e.g., log a warning if the poller skipped N cycles in a row)

## What NOT To Do

- **Don't write a "contract pinning" test that doesn't match the actual code.** A test asserting `isProtectedSender('hairboti@salonic.hu', [' salonic.hu '])` returns `false` when the implementation trims is WORSE than no test — it actively prevents someone from fixing what looks like a bug. Verify the test runs and matches the implementation before committing.
- **Don't assume env propagates.** tmux, systemd, container runtimes, ssh — all have their own env inheritance quirks. Explicit export is always safer than implicit inheritance.
- **Don't add `sleep N` to "fix" a race.** It only widens the window. Structural decoupling (file, queue, signal) eliminates the race entirely.

## When You Discover a Production-Only Bug

1. **Identify the pattern category** (stateful / external / timing).
2. **Apply the matching strategy** (extraction / full-chain test / structural decoupling).
3. **For the part you CAN'T test**, write a manual regression recipe as a comment in the test file.
4. **Document the tag** in the commit message — both the fix AND the test commit get the same tag, so future archaeology can find both halves.

## Related Codebase Locations

- `src/web/routes/background-tasks.ts` — `readOutputFile` (file-based output, structural race fix), `buildModelEnv` (testable env-extraction)
- `src/__tests__/gmail-protected-sender.test.ts` — full-chain integration tests (decodeMimeHeader → isProtectedSender)
- `src/__tests__/background-tasks.test.ts` — unit tests + manual regression recipe in one file

---

**NOTE TO ALEX**: A rendszer nem engedte, hogy közvetlenül a `~/.claude/skills/` vagy a `/home/alex/marveen/.claude/skills/` mappába írjam a skillt (fleet-szintű döntés, tudatos jóváhagyás kell). A fenti tartalom `docs/production-only-bug-testing-skill.md` formájában maradt — ha globálisan elérhetővé akarod tenni, másold át a `~/.claude/skills/production-only-bug-testing/SKILL.md` útvonalra.
