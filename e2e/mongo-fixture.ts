import {execFile, spawn, type ChildProcess} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {MongoClient} from "mongodb";

const execFileAsync = promisify(execFile);

// Overridable so a copy of this checkout synced elsewhere (to run its own disposable Mongo
// without colliding with one already bound to the default port - this checkout's own live run, or
// another synced copy's) can use a different one - same rationale/precedent as
// playwright.config.ts's own E2E_WEB_PORT override. Defaults unchanged for every normal
// `pnpm test`/`pnpm test:e2e` run. The container name is derived from the port so two concurrent
// runs on different ports can never `docker rm -f` each other's container.
export const E2E_MONGO_PORT = Number(process.env.E2E_MONGO_PORT ?? 27217);
export const E2E_MONGO_URI = `mongodb://127.0.0.1:${E2E_MONGO_PORT}/dogtag-vet-e2e`;

const CONTAINER_NAME = `dogtag-vet-e2e-mongo-${E2E_MONGO_PORT}`;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

let localMongod: ChildProcess | null = null;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

async function waitForMongoReady(uri: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, {serverSelectionTimeoutMS: 1000});
    try {
      await client.connect();
      await client.db().command({ping: 1});
      await client.close();
      return;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Mongo at ${uri} was not ready in time: ${String(lastError)}`);
}

function startLocalMongod(): void {
  const dbPath = mkdtempSync(join(tmpdir(), "dogtag-vet-e2e-mongo-"));
  localMongod = spawn("mongod", ["--dbpath", dbPath, "--port", String(E2E_MONGO_PORT), "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
}

/**
 * Starts a disposable Mongo for the e2e run - a docker container if available (this is what the
 * Definition of Done's "Playwright smoke boots against docker mongo" means in practice: the same
 * `mongo:7` image the deploy story uses everywhere else, run disposably here), else a local
 * `mongod` for a machine without Docker.
 *
 * WP4.9V finding: `dockerAvailable()` only proves the DAEMON is reachable, not that it can
 * actually provision a working container - on a long-lived, heavily shared box, Docker Desktop's
 * own virtual disk (a fixed-size allocation independent of the HOST filesystem) can fill up from
 * OTHER sessions' accumulated images/volumes/build-cache with the host itself nearly empty
 * (reproduced live: `docker run mongo:7` exited immediately, "No space left on device" writing
 * its journal, while `df -h /` showed >450GB free) - `docker info` alone can never catch this.
 * A short, bounded readiness check on the just-started container (a fraction of
 * `waitForMongoReady`'s own full budget) now falls back to a bare local `mongod` - which writes to
 * the HOST filesystem, entirely unaffected by Docker's own internal disk - rather than burning the
 * full timeout and throwing outright. Zero behavior change for the common case (a healthy docker
 * daemon with room to spare): the short check passes immediately and the docker container is used
 * exactly as before.
 */
export async function startTestMongo(): Promise<void> {
  if (await dockerAvailable()) {
    await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME]).catch(() => {});
    await execFileAsync("docker", ["run", "-d", "--name", CONTAINER_NAME, "-p", `${E2E_MONGO_PORT}:27017`, "mongo:7"]);
    try {
      await waitForMongoReady(E2E_MONGO_URI, 8_000);
      return;
    } catch (dockerError) {
      console.warn(
        `[mongo-fixture] docker mongo container did not become ready in time (${String(dockerError)}) - ` +
          "falling back to a local mongod for this run.",
      );
      await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME]).catch(() => {});
    }
  }

  startLocalMongod();
  await waitForMongoReady(E2E_MONGO_URI);
}

/**
 * Runs the same `scripts/seed.ts` a developer runs by hand (`pnpm seed`) against the disposable
 * e2e Mongo, so the smoke suite's availability assertion exercises the same demo schedule (a
 * bookable "General checkup" service, Mon-Fri 9:00-17:00 rules) everyone sees locally, rather than
 * a separate fixture that could drift from it.
 */
export async function seedTestMongo(): Promise<void> {
  await execFileAsync("pnpm", ["run", "seed"], {
    cwd: REPO_ROOT,
    env: {...process.env, MONGODB_URI: E2E_MONGO_URI},
  });
}

export async function stopTestMongo(): Promise<void> {
  if (localMongod) {
    localMongod.kill();
    localMongod = null;
    return;
  }
  await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME]).catch(() => {});
}
