import {execFile, spawn, type ChildProcess} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {MongoClient} from "mongodb";

const execFileAsync = promisify(execFile);

export const E2E_MONGO_PORT = 27217;
export const E2E_MONGO_URI = `mongodb://127.0.0.1:${E2E_MONGO_PORT}/dogtag-vet-e2e`;

const CONTAINER_NAME = "dogtag-vet-e2e-mongo";
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

/**
 * Starts a disposable Mongo for the e2e run - a docker container if available (this is what the
 * Definition of Done's "Playwright smoke boots against docker mongo" means in practice: the same
 * `mongo:7` image the deploy story uses everywhere else, run disposably here), else a local
 * `mongod` for a machine without Docker.
 */
export async function startTestMongo(): Promise<void> {
  if (await dockerAvailable()) {
    await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME]).catch(() => {});
    await execFileAsync("docker", ["run", "-d", "--name", CONTAINER_NAME, "-p", `${E2E_MONGO_PORT}:27017`, "mongo:7"]);
  } else {
    const dbPath = mkdtempSync(join(tmpdir(), "dogtag-vet-e2e-mongo-"));
    localMongod = spawn("mongod", ["--dbpath", dbPath, "--port", String(E2E_MONGO_PORT), "--bind_ip", "127.0.0.1"], {
      stdio: "ignore",
    });
  }

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
