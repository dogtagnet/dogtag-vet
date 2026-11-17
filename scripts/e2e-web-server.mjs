// The web server the Playwright suite runs against (playwright.config.ts `webServer.command`).
//
// Default: a PRODUCTION build into its own directory (NEXT_DIST_DIR), served with `next start`.
// A production server has no per-page compile step, so a loaded machine cannot make a test fail by
// being slow to compile a route (WP4.21V grade E1).
// E2E_DEV=1: `next dev`, for quick local iteration (global-setup.ts then warms every page).
//
// Why `next start` and not the standalone server the Dockerfile runs: `output: "standalone"` copies
// an incomplete node_modules (see the long comment in next.config.ts), so serving it here would need
// the Dockerfile's overlay of the full node_modules and protocol/ trees on every run. The request
// handling code is the same build output either way; `next start` reads it from the real tree.
//
// Skipping the build: the build is repeated only when its inputs changed. The inputs are hashed into
// `<distDir>/e2e-build-stamp`: the HEAD commit, the tracked diff against it, every untracked
// non-ignored file (name and content), the lockfile and every NEXT_PUBLIC_* / build-relevant
// variable in the environment. The stamp is written only after a successful build.
import {spawnSync, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import path from "node:path";

const port = process.env.E2E_WEB_PORT ?? "4210";
const dev = process.env.E2E_DEV === "1";
const distDir = process.env.NEXT_DIST_DIR;
if (!distDir) throw new Error("e2e-web-server: NEXT_DIST_DIR is not set (playwright.config.ts sets it).");

function run(cmd, args) {
  return spawnSync(cmd, args, {stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 30});
}

function inputsHash() {
  const h = createHash("sha256");
  h.update(run("git", ["rev-parse", "HEAD"]).stdout);
  h.update(run("git", ["diff", "HEAD"]).stdout);
  for (const f of run("git", ["ls-files", "-o", "--exclude-standard", "-z"]).stdout.toString().split("\0").filter(Boolean).sort()) {
    h.update(f);
    try {
      h.update(readFileSync(f));
    } catch {
      // A file that vanished between the listing and the read is simply not an input.
    }
  }
  h.update(readFileSync("pnpm-lock.yaml"));
  for (const k of Object.keys(process.env).sort()) {
    if (k.startsWith("NEXT_") || k.startsWith("E2E_") || k === "ROAX_CHAIN_ID" || k === "ROAX_EXPLORER_URL") h.update(`${k}=${process.env[k]}\n`);
  }
  return h.digest("hex");
}

function runInherit(cmd, args) {
  const r = spawnSync(cmd, args, {stdio: "inherit"});
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!dev) {
  const stampFile = path.join(distDir, "e2e-build-stamp");
  const want = inputsHash();
  const have = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : "";
  if (want === have && existsSync(path.join(distDir, "BUILD_ID"))) {
    console.log(`[e2e-web-server] ${distDir} is current for this commit, tree and environment (${want.slice(0, 12)}): skipping the build`);
  } else {
    console.log(`[e2e-web-server] building into ${distDir} (inputs ${want.slice(0, 12)}, previous ${have.slice(0, 12) || "none"})`);
    rmSync(stampFile, {force: true});
    runInherit("pnpm", ["exec", "next", "build"]);
    writeFileSync(stampFile, `${want}\n`);
  }
}

const child = spawn("pnpm", ["exec", "next", dev ? "dev" : "start", "-p", port], {stdio: "inherit"});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
