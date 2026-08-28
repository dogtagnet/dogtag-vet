"use client";

import {useState} from "react";
import {QrSurface} from "@/components/ui/QrSurface";
import {MonoValue} from "@/components/ui/MonoValue";
import {formatTokenAmount} from "@/lib/format";
import {paymentChainByKey, paymentChainDisplayName} from "@/lib/chains";
import type {CryptoRail} from "@/lib/models/Payment";

/** QR tabs, one per accepted crypto rail: amount, token, a clearly-marked network badge for
 * testnets, and a countdown to the invoice's due date (the payment window) - wp4-vet.md's payments
 * section. Shared between the staff detail page and the public `/pay/{id}` page so both render
 * identically. */
export function PaymentRailTabs({rails, dueAt}: {rails: CryptoRail[]; dueAt?: number}) {
  const [active, setActive] = useState(0);
  if (rails.length === 0) return null;
  const rail = rails[active] ?? rails[0]!;

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="mb-4 flex flex-wrap gap-2">
        {rails.map((r, i) => (
          <button
            key={`${r.chainKey}-${r.token}`}
            type="button"
            onClick={() => setActive(i)}
            className={`rounded-control border px-3 py-1.5 text-body ${
              i === active ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-muted hover:bg-surface-2"
            }`}
          >
            {paymentChainDisplayName[r.chainKey]} - {r.token}
            {Boolean(paymentChainByKey[r.chainKey].testnet) && (
              <span className="ml-1.5 rounded-badge bg-neutral-status-soft px-1.5 py-0.5 text-caption text-neutral-status">
                Testnet
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-col items-center gap-3">
        <QrSurface
          data={rail.eip681}
          expiresAt={dueAt}
          caption={`${formatTokenAmount(rail.amountBase, rail.decimals)} ${rail.token}`}
        />
        <MonoValue value={rail.receivingAddress} label="To" />
        <p className="text-caption text-ink-faint">Rate: {rail.quotedRate} per {rail.token}</p>
      </div>
    </div>
  );
}
