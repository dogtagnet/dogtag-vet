import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {decodeFunctionData, encodeFunctionResult} from "viem";
import type {Abi, Address, Hex} from "viem";
// Playwright loads e2e spec/support files through Node's own native ESM loader (unlike the Next.js
// app itself, bundled by webpack/turbopack, where a plain JSON import needs no attribute at all -
// `src/lib/abi.ts`'s own imports of these same files) - Node's native loader requires the explicit
// `with {type: "json"}` import attribute for a JSON module.
import dogTagSBTConsentAbiJson from "../protocol/contracts/exports/abi/DogTagSBTConsent.json" with {type: "json"};
import vetIssuerFactoryAbiJson from "../protocol/contracts/exports/abi/VetIssuerFactory.json" with {type: "json"};
import vetIssuerAbiJson from "../protocol/contracts/exports/abi/VetIssuer.json" with {type: "json"};

/**
 * A tiny local JSON-RPC stub standing in for the ROAX chain in e2e - answers exactly the three
 * `eth_call` selectors WP4.4's tag-claim tiers read (`profileRoot`, `rootIssuer`, `isValid`), plus
 * `eth_blockNumber`/`eth_chainId` (the pre-existing wallet-registration suite's session-creation
 * flow already depends on the first of those). Scripted per-test via a small HTTP control plane
 * (`/__control/scenario`, `/__control/reset`) rather than a mocked transport inside the app process
 * - the app under test is a REAL `next dev` server making REAL HTTP calls, so a fake in-process
 * transport is not an option; this is the smallest thing that can stand in for a real devnet RPC
 * while staying fully deterministic and offline.
 *
 * Decodes every call by trying each of the three vendored ABIs in turn (never hand-transcribed -
 * the same vendored JSON `src/lib/abi.ts` uses) and re-encodes the scripted (or default) result
 * with the SAME ABI, so the response is genuinely well-formed ABI-encoded data, not hand-built hex.
 * An unscripted (address, functionName, args) triple returns the natural "never written" value
 * (zero bytes32 / zero address / false) rather than an RPC error - matching what a real chain
 * actually returns for an unset mapping entry, and keeping every test that only cares about ONE of
 * the three reads free of needing to script the other two.
 */
const ABIS: Abi[] = [dogTagSBTConsentAbiJson as unknown as Abi, vetIssuerFactoryAbiJson as unknown as Abi, vetIssuerAbiJson as unknown as Abi];

export const RPC_STUB_PORT = 45_601;
export const RPC_STUB_URL = `http://127.0.0.1:${RPC_STUB_PORT}`;

type ScenarioResult = string | boolean;

const scenarios = new Map<string, ScenarioResult>();
/** Set to force every subsequent `eth_call` to fail (simulates an unreachable RPC) - a deliberate
 * scenario, not a bug in the stub, so tests can prove the fail-closed "chain unreadable ->
 * tagResolution: unknown, verificationError: true" path without an actual network outage. */
let forceCallFailure = false;
let blockNumber = 1_000n;

function canonicalArgKey(args: readonly unknown[]): string {
  return JSON.stringify(args.map((a) => (typeof a === "bigint" ? a.toString() : String(a).toLowerCase())));
}

function scenarioKey(functionName: string, address: string, args: readonly unknown[]): string {
  return `${functionName}:${address.toLowerCase()}:${canonicalArgKey(args)}`;
}

function defaultResultFor(functionName: string): ScenarioResult {
  if (functionName === "isValid") return false;
  if (functionName === "rootIssuer") return "0x0000000000000000000000000000000000000000";
  return `0x${"0".repeat(64)}`; // profileRoot
}

function decodeCall(data: Hex): {functionName: string; args: readonly unknown[]} | null {
  for (const abi of ABIS) {
    try {
      const decoded = decodeFunctionData({abi, data});
      return {functionName: decoded.functionName, args: (decoded.args ?? []) as readonly unknown[]};
    } catch {
      continue;
    }
  }
  return null;
}

function encodeResult(functionName: string, result: ScenarioResult): Hex | null {
  for (const abi of ABIS) {
    try {
      return encodeFunctionResult({abi, functionName, result} as Parameters<typeof encodeFunctionResult>[0]);
    } catch {
      continue;
    }
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {"content-type": "application/json", "content-length": Buffer.byteLength(text)});
  res.end(text);
}

/** Module-level singleton (not a `globalThis` hack) so `global-setup.ts` and `global-teardown.ts`
 * - two separate files, but Playwright runs both in the SAME root/orchestrator process, never a
 * worker - can start and stop the one stub server without passing a handle across a process
 * boundary. `stopStartedRpcStub` degrades gracefully (a harmless no-op) if that same-process
 * assumption is ever wrong for a given Playwright version - the stub is only a test fixture, and
 * the orchestrator process exiting at the end of the run closes its listening socket regardless. */
let activeServer: Server | undefined;

export function startRpcStub(): Server {
  const server = createServer(async (req, res) => {
    const bodyText = await readBody(req);

    if (req.method === "POST" && req.url === "/__control/reset") {
      scenarios.clear();
      forceCallFailure = false;
      sendJson(res, 200, {ok: true});
      return;
    }
    if (req.method === "POST" && req.url === "/__control/force-call-failure") {
      forceCallFailure = true;
      sendJson(res, 200, {ok: true});
      return;
    }
    if (req.method === "POST" && req.url === "/__control/scenario") {
      const body = JSON.parse(bodyText) as {functionName: string; address: string; args: string[]; result: ScenarioResult};
      scenarios.set(scenarioKey(body.functionName, body.address, body.args), body.result);
      sendJson(res, 200, {ok: true});
      return;
    }

    let rpcRequest: {jsonrpc: string; id: number; method: string; params?: unknown[]};
    try {
      rpcRequest = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, {error: "malformed JSON-RPC request"});
      return;
    }

    const reply = (result: unknown) => sendJson(res, 200, {jsonrpc: "2.0", id: rpcRequest.id, result});
    const replyError = (message: string) => sendJson(res, 200, {jsonrpc: "2.0", id: rpcRequest.id, error: {code: -32000, message}});

    if (rpcRequest.method === "eth_blockNumber") {
      blockNumber += 1n;
      reply(`0x${blockNumber.toString(16)}`);
      return;
    }
    if (rpcRequest.method === "eth_chainId") {
      reply("0x87"); // 135, this repo's ROAX chain id
      return;
    }
    if (rpcRequest.method === "eth_call") {
      if (forceCallFailure) {
        replyError("stub: simulated RPC failure");
        return;
      }
      const callParams = rpcRequest.params?.[0] as {to?: Address; data?: Hex} | undefined;
      if (!callParams?.data || !callParams.to) {
        replyError("stub: missing call params");
        return;
      }
      const decoded = decodeCall(callParams.data);
      if (!decoded) {
        replyError(`stub: unrecognized selector ${callParams.data.slice(0, 10)}`);
        return;
      }
      const scripted = scenarios.get(scenarioKey(decoded.functionName, callParams.to, decoded.args));
      const value = scripted ?? defaultResultFor(decoded.functionName);
      const encoded = encodeResult(decoded.functionName, value);
      if (!encoded) {
        replyError(`stub: could not encode result for ${decoded.functionName}`);
        return;
      }
      reply(encoded);
      return;
    }

    replyError(`stub: unsupported method ${rpcRequest.method}`);
  });
  server.listen(RPC_STUB_PORT);
  activeServer = server;
  return server;
}

export async function stopStartedRpcStub(): Promise<void> {
  if (!activeServer) return;
  const server = activeServer;
  activeServer = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function resetRpcStub(): Promise<void> {
  await fetch(`${RPC_STUB_URL}/__control/reset`, {method: "POST"});
}

export async function forceRpcCallFailure(): Promise<void> {
  await fetch(`${RPC_STUB_URL}/__control/force-call-failure`, {method: "POST"});
}

/** Scripts one `eth_call` read: the next call to `functionName` against `address` with exactly
 * `args` (decimal strings for numeric args, lowercase hex for address/bytes32 args - matching
 * `canonicalArgKey`'s own normalization) returns `result` (a hex string for
 * bytes32/address-returning functions, a boolean for `isValid`). */
export async function setRpcScenario(functionName: string, address: string, args: string[], result: ScenarioResult): Promise<void> {
  await fetch(`${RPC_STUB_URL}/__control/scenario`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({functionName, address, args, result}),
  });
}
