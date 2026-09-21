import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn, type ChildProcess} from "node:child_process";
import {createServer, type AddressInfo} from "node:net";
import mongoose from "mongoose";

/**
 * Shared bootstrap for vitest suites that need a REAL `mongod` (schema drift, index semantics,
 * concurrency against real atomic writes - things an in-memory fake can't reproduce), never the
 * live manual-E2E database on 127.0.0.1:27500. Extracted from `staleModelRepro.integration.test.ts`
 * (the first suite to need this) once a second suite (`wp47BackCompat.integration.test.ts`) needed
 * the identical bootstrap - see `stopEphemeralMongod`'s own doc comment for the bug this extraction
 * fixed in both places at once, rather than only in whichever file happened to be touched next.
 *
 * PORT ALLOCATION (root-caused twice - read both paragraphs, the second supersedes the first's
 * mechanism but not its lesson): WP4.17A D7 found that 29 call sites each hard-coded their own
 * literal port in a manually-tracked 44117-44141 range, which held only 25 distinct integers -
 * by the pigeonhole principle at least four collisions were mathematically guaranteed, and one
 * was reproduced live (two suites' mongod instances sharing a port; whichever lost the bind race
 * silently connected to the OTHER suite's already-listening instance instead of its own, then was
 * orphaned mid-test the moment that suite's own `afterAll` killed "its" process). The D7 fix
 * reassigned the four losing files to genuinely free numbers - but they were still FIXED numbers,
 * chosen by hand-auditing every sibling file's own constant, so the whole scheme only ever
 * guaranteed uniqueness WITHIN one `vitest run`. It could not, and did not, survive two independent
 * checkouts of this repo (an rsync'd grader copy and a live builder checkout, say) running the
 * suite at the same time on the same machine: both processes read the identical source, so both
 * picked the identical "free" port for every one of the 29-plus files, and collided with each
 * other exactly as D7's own two files once collided with one another.
 *
 * The actual root cause was never "which numbers are free right now" - no fixed table, however
 * carefully audited, can answer a question about a machine's live state at commit time. `mongod`'s
 * caller must ask the OS itself, at the moment it is about to spawn, every time. `startEphemeralMongod`
 * below does that: `reserveFreePort` binds a throwaway listening socket to port 0 (the OS hands back
 * a currently-unused port), reads the assigned number back, and closes the socket immediately -
 * "ask the kernel, don't guess" is the only version of this that is correct under arbitrary
 * concurrency, including two whole copies of this suite racing each other. Closing the reservation
 * socket before `mongod` binds the same port is still a reserve-then-release handoff, not a single
 * atomic operation - a second process could in principle win that same port in the narrow window
 * between the close and `mongod`'s own bind - so `startEphemeralMongod` treats a real
 * `EADDRINUSE`-shaped bind failure (mongod's own "Address already in use" from its structured JSON
 * log - written to STDOUT by default, never stderr; both streams are captured below into one
 * combined buffer for exactly this reason, confirmed directly against a real two-`mongod`-same-
 * port collision on this exact binary before relying on it) as retryable: it reserves a fresh port
 * and tries again, up to a bounded number of attempts, rather than either trusting the reservation
 * blindly or retrying forever. No caller chooses or hard-codes a port anymore; `EphemeralMongod.port`
 * reports whatever the OS actually handed out, for callers (like every integration test's own
 * `expect(mongoose.connection.port).toBe(ephemeral.port)` safety-net assertion) that want to assert
 * against it. The cheaper spawn flags, output capture, and wider readiness/hook budgets from D7
 * remain, unrelated to this port-allocation change: defense in depth against the separate, real
 * effect of several `mongod` processes actually starting concurrently on a shared, multi-agent box.
 */
export interface EphemeralMongod {
  child: ChildProcess;
  dbPath: string;
  uri: string;
  port: number;
}

/** How many times `startEphemeralMongod` will reserve a fresh port and retry after a genuine
 * bind-collision (never after any other kind of startup failure - see `looksLikeBindFailure`).
 * Bounded, not unlimited: a real, non-collision problem (a broken flag, a corrupt dbpath) must
 * still surface as a loud failure with full captured output rather than spin forever. */
const MAX_BIND_ATTEMPTS = 20;

/** Binds a throwaway listening socket to port 0 on 127.0.0.1 so the OS assigns a port that is
 * genuinely free on THIS machine right now, reads the assigned number back, then releases it by
 * closing the socket - "ask the kernel, don't guess a number from a table" (see the module doc
 * comment above for why a hard-coded table can never be correct under concurrent runs). */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? (address as AddressInfo).port : null;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
        } else if (port === null) {
          reject(new Error("reserveFreePort: server.address() returned no port"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/** True only for mongod's own documented bind-collision signature (its structured JSON log's
 * `errmsg` field literally contains "Address already in use" when `setup bind` fails - verified
 * against a real two-`mongod`-same-port collision on this exact binary, `mongod --version` 8.0.1,
 * before this regex was written; `output` is the combined stdout+stderr capture from `startEphemeralMongod`
 * below, since mongod writes this line to stdout, not stderr), never for an unrelated startup
 * failure - those must fail loud with full output on the first attempt, not silently eat
 * `MAX_BIND_ATTEMPTS` retries first. */
function looksLikeBindFailure(output: string): boolean {
  return /address already in use/i.test(output);
}

/** Polls `uri` with a throwaway connection until it accepts one (or `timeoutMs` elapses), the same
 * way every ephemeral-mongod suite in this repo always has - a freshly `spawn`-ed `mongod` is not
 * immediately ready to accept connections. Races that polling against `child`'s own `close` event
 * (deliberately `close`, not `exit`: Node.js only guarantees a process's stdio streams have fully
 * drained into the caller's output buffer by `close`, not by `exit`, which can fire first under
 * load - reading that buffer right after an `exit`-based check, as an earlier version of this
 * function did, could observe an empty buffer for a `mongod` that in fact printed a perfectly good
 * "Address already in use" a few milliseconds later, misclassifying a genuine retryable bind
 * collision as an opaque failure) - this is what lets a bind-collision retry (see `startEphemeralMongod`) happen in
 * milliseconds, with the real reason already captured, instead of waiting out the whole readiness
 * timeout first. */
async function waitForMongoReady(uri: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  const closedEarly = new Promise<never>((_resolve, reject) => {
    child.once("close", (code, signal) => {
      reject(new Error(`mongod exited before becoming ready (code ${String(code)}, signal ${String(signal)})`));
    });
  });
  const poll = (async () => {
    while (Date.now() < deadline) {
      try {
        const probe = await mongoose.createConnection(uri, {serverSelectionTimeoutMS: 1000}).asPromise();
        await probe.close();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw new Error(`mongod at ${uri} was not ready in time: ${String(lastError)}`);
  })();
  return Promise.race([poll, closedEarly]);
}

/** Spawns a throwaway `mongod` on a freshly OS-reserved free port (see the module doc comment - no
 * caller chooses or hard-codes a port anymore) with its own scratch dbpath, named `dbName` for the
 * connection URI (readability in logs/errors only). Retries on a genuine bind collision (a fresh
 * port is reserved and a fresh dbpath created for each attempt), bounded by `MAX_BIND_ATTEMPTS`.
 * Throws (after cleaning up the process and dbpath it just created) if `mongod` never becomes
 * reachable within `timeoutMs` on its final attempt, or fails for any non-bind-collision reason on
 * any attempt - the thrown error carries whatever `mongod` itself wrote to stdout AND stderr
 * (WP4.17A D7: a `stdio: "ignore"` mongod that fails to bind or start used to fail this helper with
 * nothing more diagnostic than "was not ready in time", which is how the original port collision
 * went unnoticed for as long as it did; this file's own WP4.17B follow-up found that D7's capture
 * was in fact always reading the wrong stream - mongod's structured JSON log, this fatal line
 * included, goes to stdout by default, never stderr - so both are captured now). `--wiredTigerCacheSizeGB
 * 0.25` and `diagnosticDataCollectionEnabled=false`
 * cut each throwaway instance's default footprint (WiredTiger's default cache reservation is sized
 * off the HOST's total memory, not appropriate for one of many short-lived, empty databases on a
 * shared box) - `--nojournal` is deliberately NOT here: WiredTiger has required journaling since
 * MongoDB 4.2, this repo's `mongod --version` is 8.0.1, and passing it would just fail the spawn
 * outright. */
export async function startEphemeralMongod(dbName: string, timeoutMs = 60_000): Promise<EphemeralMongod> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
    const port = await reserveFreePort();
    const dbPath = mkdtempSync(join(tmpdir(), `${dbName}-`));
    const child = spawn(
      "mongod",
      [
        "--dbpath",
        dbPath,
        "--port",
        String(port),
        "--bind_ip",
        "127.0.0.1",
        "--wiredTigerCacheSizeGB",
        "0.25",
        "--setParameter",
        "diagnosticDataCollectionEnabled=false",
      ],
      // Captures BOTH streams, not stderr alone: mongod writes its entire structured JSON log -
      // including the fatal "Address already in use" line a bind failure needs - to STDOUT by
      // default, never stderr (confirmed directly: a real two-`mongod`-same-port collision on
      // this exact binary wrote 27 log lines to stdout and 0 to stderr). An earlier version of
      // this file captured stderr only, so every thrown diagnostic here - and the bind-collision
      // retry below, which depends on actually seeing that line - silently saw an empty buffer.
      {stdio: ["ignore", "pipe", "pipe"]},
    );
    let outputBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBuf += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBuf += chunk.toString();
    });
    const uri = `mongodb://127.0.0.1:${port}/${dbName}`;
    const startedAt = Date.now();
    try {
      await waitForMongoReady(uri, timeoutMs, child);
    } catch (err) {
      await stopEphemeralMongod({child, dbPath, uri, port});
      if (looksLikeBindFailure(outputBuf) && attempt < MAX_BIND_ATTEMPTS) {
        lastError = err;
        continue; // another process won the race for this exact port - reserve a new one and retry
      }
      throw new Error(
        `${String(err)}\n--- mongod output (port ${port}, attempt ${attempt}/${MAX_BIND_ATTEMPTS}) ---\n${outputBuf || "(empty)"}`,
      );
    }
    // Not noise on the common fast path (a few hundred ms) - a visible, permanent signal if
    // readiness ever creeps toward the timeout budget on a loaded box, so a future slow run is
    // diagnosable from plain test output rather than requiring this investigation to be redone.
    const readyAfterMs = Date.now() - startedAt;
    if (readyAfterMs > 3_000) {
      console.warn(`[ephemeralMongod] port ${port} (${dbName}) took ${readyAfterMs}ms to become ready (budget ${timeoutMs}ms)`);
    }
    return {child, dbPath, uri, port};
  }
  throw new Error(`startEphemeralMongod: exhausted ${MAX_BIND_ATTEMPTS} bind attempts for ${dbName}: ${String(lastError)}`);
}

/**
 * Symmetric teardown for `startEphemeralMongod` - waits for the child process to actually EXIT
 * before removing its dbpath.
 *
 * THE BUG THIS FIXES: `mongod.kill()` alone is fire-and-forget - `kill()` sends SIGTERM and
 * returns immediately, it does not wait for the process to actually stop. Calling `rmSync` on the
 * dbpath right after `kill()` (what both suites using this helper did before it existed) races
 * mongod's own shutdown sequence, which is still actively touching files in that same directory
 * (WiredTiger journal/lock files) for a brief moment after the signal is sent - `rmSync` can
 * observe a directory entry mongod is mid-deleting/rewriting and throw `ENOTEMPTY`, exactly the
 * flake seen in a full `vitest run` (never in isolation - it needs enough concurrent load for that
 * window to actually get hit) once a second ephemeral-mongod suite started running alongside the
 * first. Waiting for the `exit` event before touching the directory closes the race entirely; the
 * 5-second fallback timeout is belt-and-braces so a suite's `afterAll` can never hang forever on a
 * process that somehow never emits it.
 */
export async function stopEphemeralMongod({child, dbPath}: EphemeralMongod): Promise<void> {
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
  rmSync(dbPath, {recursive: true, force: true});
}
