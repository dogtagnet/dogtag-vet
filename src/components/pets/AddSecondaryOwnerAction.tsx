"use client";

import {useEffect, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {Button} from "@/components/ui/controls";
import {Banner} from "@/components/ui/Banner";
import {Combobox} from "@/components/pickers/Combobox";
import {QrSurface} from "@/components/ui/QrSurface";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import type {ClientDoc} from "@/lib/models/Client";

interface StartAddResponse {
  registrationId: string;
  qr: string;
  ttlSecs: number;
  issuedAt: number;
}

interface StaffStatus {
  kind: "add" | "revoke";
  status: "pending" | "claimed" | "submitting" | "confirmed" | "error";
  errorReason?: string;
  txHash?: string;
  commitment?: string;
}

function clientSecondaryLine(client: ClientDoc): string {
  return [client.email, client.phone].filter(Boolean).join(" · ") || "No email or phone on file";
}

/**
 * WP4.15 multi-owner (PLANNED) - the pet page's "Add secondary owner" ceremony (plan section 14.1
 * item V1/V2/V3): pick an existing client with a registered wallet -> `POST
 * /api/pets/:id/delegations {mode:"add"}` -> QR -> poll staff status until `"claimed"` (the
 * secondary's own phone scanned `/d/<token>` and signed the `DelegationClaim`) -> the CONNECTED
 * operator wallet submits `addSecondaryOwner` (mirrors `TagIssueWizard`'s `handleIssue` exactly:
 * `legacyTxWithGas` headroom, a real user click - not auto-fired from a poll tick - triggers the
 * wallet prompt) -> `POST .../tx` -> `useWaitForTransactionReceipt` -> `POST .../confirm` (the
 * decisive `isSecondary` chain re-read, `lib/delegation/reconcile.ts`) -> `router.refresh()`.
 */
export function AddSecondaryOwnerAction({petId, dogTagIdField, disabled}: {petId: string; dogTagIdField: string; disabled?: boolean}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const {address, chainId} = useAccount();
  const {writeContractAsync} = useWriteContract();
  const publicClient = usePublicClient();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientDoc[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(null);
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<(StartAddResponse & {status?: StaffStatus}) | null>(null);
  const [writing, setWriting] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = undefined;
  }
  useEffect(() => stopPolling, []);

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timeoutRef.current = setTimeout(async () => {
      const res = await fetch(`/api/clients?q=${encodeURIComponent(query.trim())}`);
      if (res.ok) {
        const all = (await res.json()) as ClientDoc[];
        setResults(all.filter((c) => c.wallets.some((w) => w.revokedAt === undefined)));
      }
    }, 250);
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  function startPolling(registrationId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/pets/${petId}/delegations/${registrationId}`);
      if (!res.ok) return;
      const status = (await res.json()) as StaffStatus;
      setSession((prev) => (prev ? {...prev, status} : prev));
      if (status.status === "confirmed") {
        // Not pure overlap with the `receipt.isSuccess` effect below: `bootRecovery.ts`'s
        // `recoverStuckDelegationSessions()` can flip this session to "confirmed" in Mongo on its
        // own, independent of wagmi ever resolving a receipt in THIS tab (5-minute default stale
        // threshold - very plausible with a tab still open at the counter). When that happens,
        // this poll branch is the ONLY path that ever notices and cleans up the UI. On the common
        // fast path, where the receipt effect's own `/confirm` POST is what flips this session,
        // the next poll tick just observes the same already-idempotent result - a second toast/
        // refresh in that ordering is cosmetic and deliberately left rather than cross-effect
        // de-duplicated for a redundancy that is otherwise load-bearing.
        stopPolling();
        snackbar.show("Secondary owner added", "ok");
        router.refresh();
        setOpen(false);
        setSession(null);
        setSelectedClient(null);
      } else if (status.status === "error") {
        stopPolling();
      }
    }, 2000);
  }

  async function handleStart() {
    if (!selectedClient || !address) return;
    setStarting(true);
    try {
      const res = await fetch(`/api/pets/${petId}/delegations`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({mode: "add", clientId: selectedClient.clientId, operatorAddress: address}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Could not start the ceremony", "danger");
        return;
      }
      const started = body as StartAddResponse;
      setSession(started);
      startPolling(started.registrationId);
    } finally {
      setStarting(false);
    }
  }

  async function handleAddOnChain() {
    if (!session?.status?.commitment || !address) return;
    setWriting(true);
    try {
      const settingsRes = await fetch("/api/settings");
      const settings = settingsRes.ok ? await settingsRes.json() : null;
      if (!settings?.cloneAddress) {
        snackbar.show("This clinic has not completed setup", "danger");
        return;
      }
      const hash = await writeContractAsync(
        await legacyTxWithGas(publicClient, {
          address: settings.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "addSecondaryOwner",
          args: [BigInt(dogTagIdField), session.status.commitment as `0x${string}`],
          account: address,
        }),
      );
      await fetch(`/api/pets/${petId}/delegations/${session.registrationId}/tx`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({txHash: hash}),
      });
      setPendingTxHash(hash);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Transaction failed", "danger");
    } finally {
      setWriting(false);
    }
  }

  useEffect(() => {
    if (receipt.isSuccess && session?.registrationId) {
      fetch(`/api/pets/${petId}/delegations/${session.registrationId}/confirm`, {method: "POST"})
        .then((r) => r.json())
        .then((body) => {
          if (body.status === "confirmed") {
            snackbar.show("Secondary owner added", "ok");
            router.refresh();
            setOpen(false);
            setSession(null);
            setSelectedClient(null);
            setPendingTxHash(undefined);
          }
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Add secondary owner
      </Button>
    );
  }

  if (!session) {
    return (
      <div className="w-full rounded-card border border-border bg-surface-2 p-4">
        <p className="mb-2 text-body font-medium text-ink">Add secondary owner</p>
        {selectedClient ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-body text-ink">{selectedClient.name}</span>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleStart} disabled={starting}>
                {starting ? "Starting..." : "Start"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedClient(null)}>
                Change
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Combobox<ClientDoc>
              ariaLabel="Search clients with a registered wallet"
              placeholder="Search clients with a registered wallet"
              query={query}
              onQueryChange={setQuery}
              options={results}
              onSelect={setSelectedClient}
              getOptionKey={(client) => client.clientId}
              renderOption={(client) => (
                <div>
                  <div className="font-medium text-ink">{client.name}</div>
                  <div className="text-caption text-ink-faint">{clientSecondaryLine(client)}</div>
                </div>
              )}
              emptyHint="No matching clients with a registered wallet"
            />
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>
    );
  }

  const status = session.status?.status;

  return (
    <div className="flex w-full flex-col items-center gap-4 rounded-card border border-border bg-surface-2 p-6">
      {(!status || status === "pending") && (
        <>
          <QrSurface data={session.qr} caption="Scan with the secondary owner's DogTag app" expiresAt={session.issuedAt + session.ttlSecs} />
          {/* Same visible-link convention as WalletsPanel.tsx's wallet-registration QR - lets
              staff copy/text the link when a QR scan is not practical, and gives e2e coverage a
              way to read the token without decoding a QR image. */}
          <a
            href={session.qr}
            target="_blank"
            rel="noreferrer"
            data-testid="delegation-add-link"
            className="max-w-xs break-all text-center text-caption text-link hover:underline"
          >
            {session.qr}
          </a>
          <StatusBadge tone="info" label="Waiting for scan..." />
        </>
      )}
      {status === "claimed" && (
        <>
          <StatusBadge tone="info" label="Claim received - ready to add on chain" />
          <Button onClick={handleAddOnChain} disabled={writing || chainId !== roax.id}>
            {writing ? "Confirm in wallet..." : "Add on chain"}
          </Button>
        </>
      )}
      {(status === "submitting" || (pendingTxHash && !receipt.isSuccess)) && <StatusBadge tone="info" label="Confirming on chain..." />}
      {status === "error" && (
        <Banner tone="danger" title="Could not add this secondary owner">
          <p className="mb-3">{session.status?.errorReason ?? "Something went wrong. Start a new ceremony to try again."}</p>
          <Button
            onClick={() => {
              setSession(null);
              setPendingTxHash(undefined);
            }}
          >
            Start over
          </Button>
        </Banner>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          stopPolling();
          setOpen(false);
          setSession(null);
          setSelectedClient(null);
        }}
      >
        Close
      </Button>
    </div>
  );
}
