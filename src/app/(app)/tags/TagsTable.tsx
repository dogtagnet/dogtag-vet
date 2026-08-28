"use client";

import {useEffect, useState} from "react";
import Link from "next/link";
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {Button, Select} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTx} from "@/lib/chainWrite";
import {REASON_CODES, reasonCodeHash, type ReasonCodeName} from "@/lib/reasonCodes";
import {formatUnixSeconds} from "@/lib/format";
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
  const snackbar = useSnackbar();
  const [data, setData] = useState<TagsResponse | null>(null);
  const [busyPetId, setBusyPetId] = useState<string | null>(null);
  const [reasonByPet, setReasonByPet] = useState<Record<string, ReasonCodeName>>({});
  const [pendingTx, setPendingTx] = useState<{hash: `0x${string}`; petId: string; action: "revoke" | "reactivate"; reasonCode: ReasonCodeName} | null>(null);

  const receipt = useWaitForTransactionReceipt({hash: pendingTx?.hash, chainId: roax.id});

  async function load() {
    const res = await fetch("/api/tags");
    if (res.ok) setData(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (receipt.isSuccess && pendingTx) {
      fetch(`/api/tags/${pendingTx.petId}/lifecycle`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: pendingTx.action, reasonCode: pendingTx.reasonCode, txHash: pendingTx.hash}),
      })
        .then((r) => r.json())
        .then(() => {
          snackbar.show(`Tag ${pendingTx.action === "revoke" ? "revoked" : "reactivated"}`, "ok");
          setPendingTx(null);
          load();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  async function handleLifecycle(pet: PetDoc, action: "revoke" | "reactivate") {
    if (!address || !pet.dogTag.dogTagIdField) return;
    const reasonCode = reasonByPet[pet.petId] ?? REASON_CODES[0].name;
    setBusyPetId(pet.petId);
    try {
      const hash = await writeContractAsync(
        legacyTx({
          address: pet.dogTag.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: action === "revoke" ? "revokeTag" : "reactivateTag",
          args: [BigInt(pet.dogTag.dogTagIdField), reasonCodeHash(reasonCode)],
        }),
      );
      setPendingTx({hash, petId: pet.petId, action, reasonCode});
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
              </div>
            ),
          },
        ]}
        rows={data.issued}
        getRowKey={(p) => p.petId}
        emptyMessage="No tags issued yet."
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
