"use client";

import {useEffect, useState} from "react";
import Link from "next/link";
import {useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {Button, Select} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import {ExportQrPanel} from "@/components/tags/ExportQrPanel";
import {MaskedExportPanel} from "@/components/tags/MaskedExportPanel";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {REASON_CODES, reasonCodeHash, type ReasonCodeName} from "@/lib/reasonCodes";
import {formatUnixSeconds} from "@/lib/format";
import {decodeRefundOutcome, refundFeedbackMessage} from "@/lib/refundFeedback";
import {dogTagStatusLabel, dogTagStatusTone, mintSessionStatusLabel, mintSessionStatusTone} from "@/lib/tagStatusTone";
import type {PetDoc} from "@/lib/models/Pet";
import type {MintSessionDoc} from "@/lib/models/MintSession";

interface TagsResponse {
  issued: PetDoc[];
  inProgress: MintSessionDoc[];
}

/** `/tags` - issued tags plus in-flight mint sessions (wp4-vet.md: "DataTable of issued tags ...
 * Actions per row: revoke, reactivate, replace"). Every chain write here goes through the
 * connected operator wallet via wagmi, then confirms with `/api/tags/:petId/lifecycle`. */
export function TagsTable({timeZone}: {timeZone: string}) {
  const {address, chainId} = useAccount();
  const {writeContractAsync} = useWriteContract();
  const publicClient = usePublicClient();
  const snackbar = useSnackbar();
  const [data, setData] = useState<TagsResponse | null>(null);
  const [busyPetId, setBusyPetId] = useState<string | null>(null);
  const [reasonByPet, setReasonByPet] = useState<Record<string, ReasonCodeName>>({});
  // At most one row's export panel expanded at a time, and at most one KIND per row (a row's
  // expansion slot is a single area) - petId-keyed, same idiom WalletsPanel.tsx's expandedAddress
  // uses for its own row expansion. WP4.10V item 4 added the "mask" kind alongside the pre-existing
  // "share" (full, unmasked) export.
  const [expandedExport, setExpandedExport] = useState<{petId: string; kind: "share" | "mask"} | null>(null);
  const [pendingTx, setPendingTx] = useState<
    {hash: `0x${string}`; petId: string; cloneAddress: string; action: "revoke" | "reactivate"; reasonCode: ReasonCodeName} | null
  >(null);

  const receipt = useWaitForTransactionReceipt({hash: pendingTx?.hash, chainId: roax.id});

  async function load() {
    const res = await fetch("/api/tags");
    if (res.ok) setData(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    // `isError` too, not just `isSuccess` (2026-09-25 incident fix round 2): wagmi's own
    // `waitForTransactionReceipt` (`@wagmi/core`, what `useWaitForTransactionReceipt` calls under
    // the hood) does NOT resolve normally for a REVERTED receipt the way viem's bare action does -
    // it replays the call via `eth_call` to extract a revert reason and THROWS, so `isSuccess`
    // alone left a reverted `revokeTag`/`reactivateTag` stuck here forever with no feedback (the
    // same root cause `TagIssueWizard.tsx`'s `issueTag` receipt effect had). `/lifecycle` already
    // re-reads `isValid(root)` on chain itself before trusting either outcome (this route's own doc
    // comment), so it is safe to call it either way; `r.ok` is now checked instead of assumed, so a
    // genuine revert (400) shows an honest failure instead of a false "Tag revoked"/"reactivated".
    if ((receipt.isSuccess || receipt.isError) && pendingTx) {
      fetch(`/api/tags/${pendingTx.petId}/lifecycle`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: pendingTx.action, reasonCode: pendingTx.reasonCode, txHash: pendingTx.hash}),
      })
        .then(async (r) => ({ok: r.ok, body: await r.json().catch(() => null)}))
        .then(({ok, body}) => {
          if (ok) {
            // WP4.19 V2 - only on an actually-successful receipt: a reverted revoke/reactivate
            // refunds nothing (see TagIssueWizard.tsx's identical comment on its own issueTag
            // effect for why), and `ok` here already implies `receipt.isSuccess` (the lifecycle
            // route's own `r.ok` check re-verifies against the chain before ever returning success).
            const refundMessage =
              receipt.isSuccess && receipt.data ? ` ${refundFeedbackMessage(decodeRefundOutcome(receipt.data.logs, pendingTx.cloneAddress))}` : "";
            snackbar.show(`Tag ${pendingTx.action === "revoke" ? "revoked" : "reactivated"}.${refundMessage}`, "ok");
          } else {
            snackbar.show(body?.error?.message ?? `Tag ${pendingTx.action} transaction failed`, "danger");
          }
          setPendingTx(null);
          load();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, receipt.isError]);

  async function handleLifecycle(pet: PetDoc, action: "revoke" | "reactivate") {
    if (!address || !pet.dogTag.dogTagIdField) return;
    const reasonCode = reasonByPet[pet.petId] ?? REASON_CODES[0].name;
    setBusyPetId(pet.petId);
    try {
      const hash = await writeContractAsync(
        // Headroom over the bare estimate - see legacyTxWithGas's doc comment for the incident
        // txs the refund tail starved at the wallet's own estimate.
        await legacyTxWithGas(publicClient, {
          address: pet.dogTag.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: action === "revoke" ? "revokeTag" : "reactivateTag",
          args: [BigInt(pet.dogTag.dogTagIdField), reasonCodeHash(reasonCode)],
          account: address,
        }),
      );
      setPendingTx({hash, petId: pet.petId, cloneAddress: pet.dogTag.cloneAddress as string, action, reasonCode});
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Transaction failed", "danger");
    } finally {
      setBusyPetId(null);
    }
  }

  if (!data) return <p className="text-body text-ink-faint">Loading...</p>;

  return (
    <div className="space-y-8">
      <DataTable
        columns={[
          {key: "id", header: "Tag id", mono: true, render: (p: PetDoc) => p.dogTag.dogTagIdDec},
          {
            key: "pet",
            header: "Pet",
            render: (p: PetDoc) => (
              <Link href={`/pets/${p.petId}`} className="text-link hover:underline">
                {p.name}
              </Link>
            ),
          },
          {key: "root", header: "Root", render: (p: PetDoc) => (p.dogTag.root ? <HashCell value={p.dogTag.root} kind="root" /> : "-")},
          {
            key: "status",
            header: "Status",
            render: (p: PetDoc) => {
              const status = p.dogTag.status;
              return status ? (
                <StatusBadge tone={dogTagStatusTone[status]} label={dogTagStatusLabel[status]} />
              ) : (
                <StatusBadge tone="neutral" label="Unknown" />
              );
            },
          },
          {
            key: "issuedAt",
            header: "Issued date",
            render: (p: PetDoc) =>
              p.dogTag.issuedAt ? formatUnixSeconds(Math.floor(new Date(p.dogTag.issuedAt).getTime() / 1000), timeZone) : "-",
          },
          {key: "tx", header: "Issued tx", render: (p: PetDoc) => (p.dogTag.issuedTx ? <HashCell value={p.dogTag.issuedTx} chain="roax" kind="tx" /> : "-")},
          {
            key: "actions",
            header: "Actions",
            render: (p: PetDoc) => (
              <div className="flex items-center gap-2">
                <Select
                  className="w-auto"
                  value={reasonByPet[p.petId] ?? REASON_CODES[0].name}
                  onChange={(e) => setReasonByPet((v) => ({...v, [p.petId]: e.target.value as ReasonCodeName}))}
                  aria-label="Reason code"
                >
                  {REASON_CODES.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.label}
                    </option>
                  ))}
                </Select>
                {p.dogTag.status === "active" ? (
                  <Button
                    variant="danger"
                    disabled={busyPetId === p.petId || chainId !== roax.id}
                    onClick={() => handleLifecycle(p, "revoke")}
                  >
                    Revoke
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={busyPetId === p.petId || chainId !== roax.id}
                    onClick={() => handleLifecycle(p, "reactivate")}
                  >
                    Reactivate
                  </Button>
                )}
                <Link href={`/tags/issue?replace=${p.petId}`} className="text-body text-link hover:underline">
                  Replace
                </Link>
                {p.dogTag.status !== "revoked" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={expandedExport?.petId === p.petId && expandedExport.kind === "share"}
                      aria-controls={`export-panel-${p.petId}`}
                      onClick={() =>
                        setExpandedExport((prev) => (prev?.petId === p.petId && prev.kind === "share" ? null : {petId: p.petId, kind: "share"}))
                      }
                    >
                      {expandedExport?.petId === p.petId && expandedExport.kind === "share" ? "Hide share code" : "Share tag data"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={expandedExport?.petId === p.petId && expandedExport.kind === "mask"}
                      aria-controls={`export-panel-${p.petId}`}
                      onClick={() =>
                        setExpandedExport((prev) => (prev?.petId === p.petId && prev.kind === "mask" ? null : {petId: p.petId, kind: "mask"}))
                      }
                    >
                      {expandedExport?.petId === p.petId && expandedExport.kind === "mask" ? "Hide masked export" : "Export with masking"}
                    </Button>
                  </>
                )}
              </div>
            ),
          },
        ]}
        rows={data.issued}
        getRowKey={(p) => p.petId}
        emptyMessage="No tags issued yet."
        renderExpansion={(p) =>
          expandedExport?.petId === p.petId ? (
            <div id={`export-panel-${p.petId}`}>
              {expandedExport.kind === "share" ? (
                <ExportQrPanel petId={p.petId} onClose={() => setExpandedExport(null)} />
              ) : (
                <MaskedExportPanel petId={p.petId} onClose={() => setExpandedExport(null)} />
              )}
            </div>
          ) : null
        }
      />

      {data.inProgress.length > 0 && (
        <div>
          <h3 className="mb-3 text-section-title text-ink">In progress</h3>
          <DataTable
            columns={[
              {key: "id", header: "Tag id", mono: true, render: (s: MintSessionDoc) => s.dogTagIdDec},
              {key: "pet", header: "Pet", render: (s: MintSessionDoc) => s.petName},
              {
                key: "status",
                header: "Status",
                render: (s: MintSessionDoc) => (
                  <StatusBadge tone={mintSessionStatusTone[s.status]} label={mintSessionStatusLabel[s.status]} />
                ),
              },
              {
                key: "created",
                header: "Started",
                render: (s: MintSessionDoc) => formatUnixSeconds(Math.floor(new Date(s.createdAt).getTime() / 1000), timeZone),
              },
              {
                key: "resume",
                header: "",
                render: (s: MintSessionDoc) => (
                  <Link href={`/tags/issue?session=${s.sessionId}`} className="text-body text-link hover:underline">
                    Continue
                  </Link>
                ),
              },
            ]}
            rows={data.inProgress}
            getRowKey={(s) => s.sessionId}
          />
        </div>
      )}
    </div>
  );
}
