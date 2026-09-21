"use client";

import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input, Select, Textarea} from "@/components/ui/controls";
import {FormActionBar, FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {ClientDoc} from "@/lib/models/Client";
import type {PetDoc} from "@/lib/models/Pet";
import {paymentChainByKey, paymentChainDisplayName, type PaymentChainKey} from "@/lib/chains";
import {ALL_CHAIN_KEYS, tokensFor} from "@/lib/payments/tokenTable";
import type {PaymentToken} from "@/lib/models/Payment";
import type {RailAvailability} from "@/app/api/payments/rails/route";

interface LineItemRow {
  description: string;
  qty: string;
  unitAmount: string;
}

interface RailSelection {
  chainKey: PaymentChainKey;
  token: PaymentToken;
  manualRate: string;
}

function railKey(chainKey: string, token: string): string {
  return `${chainKey}:${token}`;
}

/** RUSD's manual rate prefills to "1.00" the moment it's selected for a USD invoice (plans/
 * wp4.18-roax-payments.md section 6: "the RUSD rail defaults its manual rate to 1.00 when the
 * clinic's fiat currency is USD and requires an explicit rate otherwise") - a form-side
 * convenience only, still fully editable, and still enforced server-side regardless (`POST
 * /api/payments` rejects any rail with a blank `manualRate`, PLASMA and RUSD alike). */
function defaultManualRateFor(token: PaymentToken, currency: string): string {
  return token === "RUSD" && currency.trim().toUpperCase() === "USD" ? "1.00" : "";
}

export function PaymentForm() {
  const router = useRouter();
  const snackbar = useSnackbar();

  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<ClientDoc[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(null);
  const [pets, setPets] = useState<PetDoc[]>([]);
  const [petId, setPetId] = useState("");

  const [lineItems, setLineItems] = useState<LineItemRow[]>([{description: "", qty: "1", unitAmount: ""}]);
  const [currency, setCurrency] = useState("USD");
  const [taxLabel, setTaxLabel] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  const [availableRails, setAvailableRails] = useState<RailAvailability[]>([]);
  const [selectedRails, setSelectedRails] = useState<Map<string, RailSelection>>(new Map());

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/payments/rails")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAvailableRails);
  }, []);

  useEffect(() => {
    if (!clientQuery.trim()) {
      setClientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/clients?q=${encodeURIComponent(clientQuery.trim())}`);
      if (res.ok) setClientResults(await res.json());
    }, 250);
    return () => clearTimeout(t);
  }, [clientQuery]);

  useEffect(() => {
    if (!selectedClient) {
      setPets([]);
      setPetId("");
      return;
    }
    fetch(`/api/pets?ownerClientId=${selectedClient.clientId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPets);
  }, [selectedClient]);

  function toggleRail(chainKey: PaymentChainKey, token: PaymentToken) {
    setSelectedRails((prev) => {
      const next = new Map(prev);
      const key = railKey(chainKey, token);
      if (next.has(key)) next.delete(key);
      else next.set(key, {chainKey, token, manualRate: defaultManualRateFor(token, currency)});
      return next;
    });
  }

  function setManualRate(chainKey: string, token: string, rate: string) {
    setSelectedRails((prev) => {
      const next = new Map(prev);
      const key = railKey(chainKey, token);
      const existing = next.get(key);
      if (existing) next.set(key, {...existing, manualRate: rate});
      return next;
    });
  }

  function addLineItem() {
    setLineItems((prev) => [...prev, {description: "", qty: "1", unitAmount: ""}]);
  }

  function updateLineItem(index: number, patch: Partial<LineItemRow>) {
    setLineItems((prev) => prev.map((row, i) => (i === index ? {...row, ...patch} : row)));
  }

  function removeLineItem(index: number) {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    if (lineItems.some((li) => !li.description.trim() || !li.unitAmount.trim())) {
      snackbar.show("Every line item needs a description and unit amount", "danger");
      return;
    }
    // ROAX rails are manual-rate only (no live quote to fall back to) - checked here so a blank
    // rate is caught before the round trip, mirroring the line-item check above; `POST
    // /api/payments` enforces the same rule server-side regardless.
    if (Array.from(selectedRails.values()).some((r) => !r.manualRate.trim())) {
      snackbar.show("Enter a manual rate for every selected rail", "danger");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        clientId: selectedClient?.clientId,
        petId: petId || undefined,
        lineItems: lineItems.map((li) => ({
          description: li.description.trim(),
          qty: Number(li.qty),
          unitAmount: li.unitAmount.trim(),
        })),
        currency,
        tax: taxLabel.trim() && taxRate.trim() ? {label: taxLabel.trim(), rate: taxRate.trim()} : undefined,
        dueAt: dueDate ? Math.floor(new Date(dueDate).getTime() / 1000) : undefined,
        acceptedRails: Array.from(selectedRails.values()).map((r) => ({
          chainKey: r.chainKey,
          token: r.token,
          manualRate: r.manualRate.trim(),
        })),
        notes: notes.trim() || undefined,
      };

      const res = await fetch("/api/payments", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("Create failed");

      const created = await res.json();
      snackbar.show("Payment created", "ok");
      router.push(`/payments/${created.paymentId}`);
    } catch {
      snackbar.show("Could not create payment - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <FormSection title="Client" helperText="Optional - leave blank for a walk-in invoice.">
        <FormField label="Search clients" htmlFor="payment-client-search">
          <Input
            id="payment-client-search"
            value={selectedClient ? selectedClient.name : clientQuery}
            onChange={(e) => {
              setSelectedClient(null);
              setClientQuery(e.target.value);
            }}
            placeholder="Name, email, or phone"
          />
        </FormField>
        {clientResults.length > 0 && !selectedClient && (
          <ul className="divide-y divide-border rounded-control border border-border">
            {clientResults.map((c) => (
              <li key={c.clientId}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-body hover:bg-surface-2"
                  onClick={() => {
                    setSelectedClient(c);
                    setClientResults([]);
                  }}
                >
                  {c.name} {c.email ? `- ${c.email}` : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedClient && pets.length > 0 && (
          <FormField label="Pet" htmlFor="payment-pet">
            <Select id="payment-pet" value={petId} onChange={(e) => setPetId(e.target.value)}>
              <option value="">No specific pet</option>
              {pets.map((p) => (
                <option key={p.petId} value={p.petId}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
      </FormSection>

      <FormSection title="Line items">
        <div className="space-y-3">
          {lineItems.map((item, index) => (
            // WP4.7 A7 - was three wrapper divs (Input's base class is w-full, which plain string
            // concatenation could never override); controls.tsx now merges className via
            // tailwind-merge (cn()) and FormField takes its own className (for sizing its outer
            // box within this row), so none of the three is needed any more.
            <div key={index} className="flex items-end gap-2">
              <FormField label="Description" htmlFor={`li-desc-${index}`} className="min-w-0 flex-1">
                <Input
                  id={`li-desc-${index}`}
                  value={item.description}
                  onChange={(e) => updateLineItem(index, {description: e.target.value})}
                />
              </FormField>
              <FormField label="Qty" htmlFor={`li-qty-${index}`} className="w-20 shrink-0">
                <Input
                  id={`li-qty-${index}`}
                  type="number"
                  min={0}
                  value={item.qty}
                  onChange={(e) => updateLineItem(index, {qty: e.target.value})}
                />
              </FormField>
              <FormField label="Unit amount" htmlFor={`li-unit-${index}`} className="w-28 shrink-0">
                <Input
                  id={`li-unit-${index}`}
                  value={item.unitAmount}
                  onChange={(e) => updateLineItem(index, {unitAmount: e.target.value})}
                  placeholder="0.00"
                />
              </FormField>
              <Button variant="ghost" type="button" onClick={() => removeLineItem(index)} disabled={lineItems.length === 1}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="secondary" type="button" onClick={addLineItem}>
            Add line item
          </Button>
        </div>
      </FormSection>

      <FormSection title="Totals">
        <FormField label="Currency" htmlFor="payment-currency">
          <Input id="payment-currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        </FormField>
        {/* WP4.7 A7 - was two wrapper divs, same reason as the line-items row above. */}
        <div className="flex gap-2">
          <FormField
            label="Tax label"
            htmlFor="payment-tax-label"
            helperText="Leave both fields blank for no tax"
            className="min-w-0 flex-1"
          >
            <Input id="payment-tax-label" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} placeholder="Sales tax" />
          </FormField>
          <FormField label="Tax rate" htmlFor="payment-tax-rate" className="w-32 shrink-0">
            <Input id="payment-tax-rate" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0.0825" />
          </FormField>
        </div>
        <FormField label="Due date" htmlFor="payment-due-date">
          <Input id="payment-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </FormField>
      </FormSection>

      <FormSection title="Crypto payment rails" helperText="Toggle which ROAX assets this invoice accepts. Every rail needs a manual rate - there is no live price feed.">
        {ALL_CHAIN_KEYS.map((chainKey) => (
          <div key={chainKey}>
            <p className="mb-1.5 text-body font-medium text-ink">
              {paymentChainDisplayName[chainKey]}
              {Boolean(paymentChainByKey[chainKey].testnet) && (
                <span className="ml-2 rounded-badge bg-neutral-status-soft px-2 py-0.5 text-caption text-neutral-status">
                  Testnet
                </span>
              )}
            </p>
            <div className="mb-3 flex flex-wrap gap-3">
              {tokensFor(chainKey).map((token) => {
                const key = railKey(chainKey, token);
                const availability = availableRails.find((r) => r.chainKey === chainKey && r.token === token);
                const disabled = availability ? !availability.receivingAddressConfigured : false;
                const selection = selectedRails.get(key);
                return (
                  <div key={key} className="flex flex-col gap-1.5">
                    <label
                      className={`flex items-center gap-2 rounded-control border border-border px-3 py-1.5 text-body ${
                        disabled ? "opacity-50" : "cursor-pointer hover:bg-surface-2"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(selection)}
                        disabled={disabled}
                        onChange={() => toggleRail(chainKey, token)}
                      />
                      {token}
                      {availability?.placeholder && (
                        <span className="text-caption text-warn" title="Placeholder token address - override via env before real use">
                          placeholder
                        </span>
                      )}
                    </label>
                    {selection && (
                      <FormField label={`Manual rate (${currency || "fiat"} per ${token})`} htmlFor={`manual-rate-${key}`} className="w-48">
                        <Input
                          id={`manual-rate-${key}`}
                          value={selection.manualRate}
                          onChange={(e) => setManualRate(chainKey, token, e.target.value)}
                          placeholder="e.g. 1.00"
                        />
                      </FormField>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </FormSection>

      <FormSection title="Notes">
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes, optional" />
      </FormSection>

      <FormActionBar>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Creating..." : "Create payment"}
        </Button>
      </FormActionBar>
    </div>
  );
}
