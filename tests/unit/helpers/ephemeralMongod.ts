import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn, type ChildProcess} from "node:child_process";
import mongoose from "mongoose";

/**
 * Shared bootstrap for vitest suites that need a REAL `mongod` (schema drift, index semantics,
 * concurrency against real atomic writes - things an in-memory fake can't reproduce), never the
 * live manual-E2E database on 127.0.0.1:27500. Extracted from `staleModelRepro.integration.test.ts`
 * (the first suite to need this) once a second suite (`wp47BackCompat.integration.test.ts`) needed
 * the identical bootstrap - see `stopEphemeralMongod`'s own doc comment for the bug this extraction
 * fixed in both places at once, rather than only in whichever file happened to be touched next.
 *
 * Each call site is responsible for choosing its own port (> 44000, unique across every ephemeral-
 * mongod suite in this repo so concurrent `vitest run` workers never collide) and for establishing
 * whatever mongoose connection strategy IT needs against the returned `uri` (a raw `mongoose.
 * connect(uri)`, or setting `process.env.MONGODB_URI` for `connectToDatabase()` to pick up) - this
 * helper only owns the child process lifecycle, not the connection itself, since call sites
 * legitimately differ on that part.
 *
 * WP4.17A D7 - "unique across every ephemeral-mongod suite" was violated by FOUR of the 29 call
 * sites (44137, 44138, 44139, 44140 each double-booked; a plain `git grep` audit, not a guess -
 * 29 files cannot hold 25 distinct values in the 44117-44141 range that had been carved out for
 * them, by the pigeonhole principle alone). Under `--poolOptions.forks.maxForks=4`, two suites
 * sharing a port can schedule onto different concurrent forks: whichever loses the bind race
 * either times out against a port nothing is listening on yet, or - worse, and what actually
 * reproduced here - silently connects to the OTHER suite's already-listening mongod (same host,
 * same port, merely a different database name, which is not enough to keep them apart at the
 * process level), which is then killed out from under it the moment the first suite's OWN
 * `afterAll` calls `stopEphemeralMongod` (`MongoServerError: interrupted at shutdown`, cascading
 * into hook/test timeouts in whichever suite got orphaned). Fixed by giving all 29 call sites
 * genuinely distinct ports (see each file's own `MONGO_PORT` constant). The cheaper spawn flags,
 * stderr capture, and wider readiness/hook budgets below are defense in depth against the
 * separate, real-but-smaller effect of several `mongod` processes actually starting concurrently
 * on a shared, multi-agent box - not a mask for the collision, which is fixed at its own root.
 */
export interface EphemeralMongod {
  child: ChildProcess;
  dbPath: string;
  uri: string;
}

/** Polls `uri` with a throwaway connection until it accepts one (or `timeoutMs` elapses), the same
 * way every ephemeral-mongod suite in this repo always has - a freshly `spawn`-ed `mongod` is not
 * immediately ready to accept connections. */
async function waitForMongoReady(uri: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
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
}

/** Spawns a throwaway `mongod` on `port` with its own scratch dbpath, named `dbName` for the
 * connection URI (readability in logs/errors only). Throws (after cleaning up the process and
 * dbpath it just created) if `mongod` never becomes reachable within `timeoutMs` - the thrown
 * error carries whatever `mongod` itself wrote to stderr (WP4.17A D7: a `stdio: "ignore"` mongod
 * that fails to bind or start used to fail this helper with nothing more diagnostic than "was not
 * ready in time", which is how the port collision above went unnoticed for as long as it did).
 * `--wiredTigerCacheSizeGB 0.25` and `diagnosticDataCollectionEnabled=false` cut each throwaway
 * instance's default footprint (WiredTiger's default cache reservation is sized off the HOST's
 * total memory, not appropriate for one of many short-lived, empty databases on a shared box) -
 * `--nojournal` is deliberately NOT here: WiredTiger has required journaling since MongoDB 4.2,
 * this repo's `mongod --version` is 8.0.1, and passing it would just fail the spawn outright. */
export async function startEphemeralMongod(port: number, dbName: string, timeoutMs = 60_000): Promise<EphemeralMongod> {
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
    {stdio: ["ignore", "ignore", "pipe"]},
  );
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });
  const uri = `mongodb://127.0.0.1:${port}/${dbName}`;
  const startedAt = Date.now();
  try {
    await waitForMongoReady(uri, timeoutMs);
  } catch (err) {
    await stopEphemeralMongod({child, dbPath, uri});
    throw new Error(`${String(err)}\n--- mongod stderr (port ${port}) ---\n${stderrBuf || "(empty)"}`);
  }
  // Not noise on the common fast path (a few hundred ms) - a visible, permanent signal if
  // readiness ever creeps toward the timeout budget on a loaded box, so a future slow run is
  // diagnosable from plain test output rather than requiring this investigation to be redone.
  const readyAfterMs = Date.now() - startedAt;
  if (readyAfterMs > 3_000) {
    console.warn(`[ephemeralMongod] port ${port} (${dbName}) took ${readyAfterMs}ms to become ready (budget ${timeoutMs}ms)`);
  }
  return {child, dbPath, uri};
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
