"use client";

import {useEffect, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {AddressChip} from "@/components/ui/AddressChip";
import {Banner} from "@/components/ui/Banner";
import {Button, Input} from "@/components/ui/controls";
import {DataTable} from "@/components/ui/DataTable";
import {FormSection} from "@/components/ui/FormSection";
import {QrSurface} from "@/components/ui/QrSurface";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {formatUnixSeconds} from "@/lib/format";
import {registrationStatusLabel, registrationStatusTone} from "@/lib/registrationStatusTone";
import {receiptExportJson} from "@/lib/registration/receipt";
import type {RegistrationStatus} from "@/lib/registration/flow";
import type {ClientWallet} from "@/lib/models/Client";

interface StartSessionResponse {
  token: string;
  qr: string;
  registrationId: string;
  ttlSecs: number;
  issuedAt: number;
  blockNumber: number;
}

interface ActiveSession extends StartSessionResponse {
  status: RegistrationStatus;
  registeredWallet?: string;
}

/** Small text field bound to one wallet's label, saving on blur only when the trimmed value
 * actually changed - kept as its own component (not an inline closure in a DataTable `render`)
 * so it can hold its own draft-text state between keystrokes. */
function WalletLabelField({wallet, onSave}: {wallet: ClientWallet; onSave: (address: string, label: string) => void}) {
  const [value, setValue] = useState(wallet.label ?? "");
  useEffect(() => setValue(wallet.label ?? ""), [wallet.label]);
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed !== (wallet.label ?? "")) onSave(wallet.address, trimmed);
      }}
      placeholder="Add a label"
      aria-label={`Label for ${wallet.address}`}
      className="w-full min-w-[100px] max-w-[160px]"
    />
  );
}

/** Inline two-step confirm (design-system.md has no native-dialog convention anywhere else in
 * this app) - first click asks for confirmation in place, second click actually revokes. */
function RevokeButton({onConfirm}: {onConfirm: () => void}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Revoke
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="danger"
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        Confirm revoke
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  );
}

/** A collapsed-by-default raw-JSON view, for inspecting a receipt without leaving the page -
 * `<details>` needs no new design-system component and is keyboard/AT accessible for free.
 * `receipt.payloadJson` is itself a JSON-encoded STRING (an embedded blob with no internal line
 * breaks), so `<pre>`'s default `white-space: pre` would render that one field as a single
 * multi-hundred-character line - `whitespace-pre-wrap break-all` wraps it (and every other long
 * unbroken token, like the signature/hash hex strings) at the block's own width instead of ever
 * growing wider than its container or relying on a horizontal scrollbar inside a table cell. */
function ReceiptDisclosure({wallet}: {wallet: ClientWallet}) {
  return (
    <details className="text-caption">
      <summary className="cursor-pointer text-link hover:underline">Receipt</summary>
      <pre className="mt-2 max-w-xs whitespace-pre-wrap break-all rounded-control bg-surface-2 p-3 text-left font-mono text-caption text-ink">
        {receiptExportJson(wallet)}
      </pre>
    </details>
  );
}

function downloadReceipt(wallet: ClientWallet) {
  const json = receiptExportJson(wallet);
  const blob = new Blob([json], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wallet-receipt-${wallet.address}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * The client detail page's "Wallets" panel - plans/wp4.2-client-wallet-registration.md, dogtag-vet
 * section 6. Registered wallets list (AddressChip, inline label edit, revoke with confirm, receipt
 * view/download) plus "Register wallet" -> QR + TTL caption + live status polling
 * ("Waiting for scan..." -> "Wallet 0x... registered").
 */
export function WalletsPanel({clientId, wallets, timeZone}: {clientId: string; wallets: ClientWallet[]; timeZone: string}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = undefined;
  }
  useEffect(() => stopPolling, []);

  function startPolling(registrationId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/clients/${clientId}/wallet-registrations/${registrationId}`);
      if (!res.ok) return;
      const body = (await res.json()) as {status: RegistrationStatus; wallet?: string};
      setSession((prev) => (prev ? {...prev, status: body.status, registeredWallet: body.wallet} : prev));
      if (body.status === "registered") {
        stopPolling();
        snackbar.show(`Wallet ${body.wallet} registered`, "ok");
        router.refresh();
        setTimeout(() => setSession(null), 1800);
      } else if (body.status === "failed" || body.status === "expired") {
        stopPolling();
      }
    }, 2000);
  }

  async function handleRegister() {
    setStarting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/wallet-registrations`, {method: "POST"});
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Could not start a wallet registration", "danger");
        return;
      }
      const started = body as StartSessionResponse;
      setSession({...started, status: "waiting"});
      startPolling(started.registrationId);
    } finally {
      setStarting(false);
    }
  }

  async function handleRevoke(address: string) {
    const res = await fetch(`/api/clients/${clientId}/wallets/${address}/revoke`, {method: "POST"});
    if (!res.ok) {
      snackbar.show("Could not revoke this wallet", "danger");
      return;
    }
    snackbar.show("Wallet revoked", "ok");
    router.refresh();
  }

  async function handleLabelSave(address: string, label: string) {
    const res = await fetch(`/api/clients/${clientId}/wallets/${address}`, {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({label}),
    });
    if (!res.ok) {
      snackbar.show("Could not save the label", "danger");
      return;
    }
    router.refresh();
  }

  return (
    <FormSection title="Wallets" helperText="Wallets this client has registered for bookkeeping. No on-chain writes.">
      <DataTable<ClientWallet>
        columns={[
          {key: "address", header: "Address", render: (w) => <AddressChip address={w.address} />},
          {key: "label", header: "Label", render: (w) => <WalletLabelField wallet={w} onSave={handleLabelSave} />},
          {
            key: "status",
            header: "Status",
            render: (w) => (
              <div className="flex flex-col items-start gap-1">
                {w.revokedAt ? <StatusBadge tone="danger" label="Revoked" /> : <StatusBadge tone="ok" label="Active" />}
                <span className="text-caption text-ink-faint">{formatUnixSeconds(w.registeredAt, timeZone)}</span>
              </div>
            ),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (w) => (
              <div className="flex flex-wrap items-start justify-end gap-2">
                <ReceiptDisclosure wallet={w} />
                <Button variant="ghost" onClick={() => downloadReceipt(w)}>
                  Download
                </Button>
                {!w.revokedAt && <RevokeButton onConfirm={() => handleRevoke(w.address)} />}
              </div>
            ),
          },
        ]}
        rows={wallets}
        getRowKey={(w) => w.address}
        emptyMessage="No wallets registered yet."
      />

      {session ? (
        <div className="flex flex-col items-center gap-4 rounded-card border border-border bg-surface-2 p-6">
          {session.status === "waiting" && (
            <>
              <QrSurface
                data={session.qr}
                caption="Scan with the owner's DogTag app"
                expiresAt={session.issuedAt + session.ttlSecs}
              />
              <a
                href={session.qr}
                target="_blank"
                rel="noreferrer"
                data-testid="wallet-registration-link"
                className="max-w-xs break-all text-center text-caption text-link hover:underline"
              >
                {session.qr}
              </a>
              <StatusBadge tone={registrationStatusTone.waiting} label={registrationStatusLabel.waiting} />
            </>
          )}

          {session.status === "registered" && (
            <p className="text-body text-ok">
              Wallet <AddressChip address={session.registeredWallet ?? ""} /> registered
            </p>
          )}

          {(session.status === "failed" || session.status === "expired") && (
            <Banner tone="danger" title={registrationStatusLabel[session.status]}>
              <p className="mb-3">
                {session.status === "failed"
                  ? "The signature did not match this wallet. This code cannot be reused - generate a new one."
                  : "This code expired before it was used. Generate a new one."}
              </p>
              <Button onClick={handleRegister} disabled={starting}>
                Generate a new code
              </Button>
            </Banner>
          )}
        </div>
      ) : (
        <div className="flex justify-end">
          <Button onClick={handleRegister} disabled={starting}>
            {starting ? "Starting..." : "Register wallet"}
          </Button>
        </div>
      )}
    </FormSection>
  );
}
