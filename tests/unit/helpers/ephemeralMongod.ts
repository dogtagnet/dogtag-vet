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
 * dbpath it just created) if `mongod` never becomes reachable within `timeoutMs`. */
export async function startEphemeralMongod(port: number, dbName: string, timeoutMs = 20_000): Promise<EphemeralMongod> {
  const dbPath = mkdtempSync(join(tmpdir(), `${dbName}-`));
  const child = spawn("mongod", ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const uri = `mongodb://127.0.0.1:${port}/${dbName}`;
  try {
    await waitForMongoReady(uri, timeoutMs);
  } catch (err) {
    await stopEphemeralMongod({child, dbPath, uri});
    throw err;
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
