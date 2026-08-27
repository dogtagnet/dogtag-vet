"use client";

import {useState} from "react";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {Button, Input} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {ClinicSettingsDoc, ReceivingAddress} from "@/lib/models/ClinicSettings";
import type {PaymentChainKey} from "@/lib/chains";

const paymentChainLabels: Record<PaymentChainKey, string> = {
  ethereum: "Ethereum",
  base: "Base",
  sepolia: "Sepolia (testnet)",
  baseSepolia: "Base Sepolia (testnet)",
};
const paymentChainKeys = Object.keys(paymentChainLabels) as PaymentChainKey[];

export function SettingsForm({initial}: {initial: ClinicSettingsDoc}) {
  const snackbar = useSnackbar();
  const [businessName, setBusinessName] = useState(initial.businessProfile?.name ?? "");
  const [logoUrl, setLogoUrl] = useState(initial.businessProfile?.logoUrl ?? "");
  const [receiving, setReceiving] = useState<Record<PaymentChainKey, string>>(() => {
    const map: Record<PaymentChainKey, string> = {ethereum: "", base: "", sepolia: "", baseSepolia: ""};
    for (const entry of initial.receivingAddresses ?? []) map[entry.chainKey] = entry.address;
    return map;
  });
  const [rpc, setRpc] = useState({
    roax: initial.rpcOverrides?.roax ?? "",
    ethereum: initial.rpcOverrides?.ethereum ?? "",
    base: initial.rpcOverrides?.base ?? "",
    sepolia: initial.rpcOverrides?.sepolia ?? "",
    baseSepolia: initial.rpcOverrides?.baseSepolia ?? "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    const receivingAddresses: ReceivingAddress[] = paymentChainKeys
      .filter((key) => receiving[key])
      .map((key) => ({chainKey: key, address: receiving[key]}));
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          businessProfile: {name: businessName || undefined, logoUrl: logoUrl || undefined},
          receivingAddresses,
          rpcOverrides: {
            roax: rpc.roax || undefined,
            ethereum: rpc.ethereum || undefined,
            base: rpc.base || undefined,
            sepolia: rpc.sepolia || undefined,
            baseSepolia: rpc.baseSepolia || undefined,
          },
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      snackbar.show("Settings saved", "ok");
    } catch {
      snackbar.show("Could not save settings - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <FormSection title="Business profile" helperText="Shown on invoices and the clinic's public entity card.">
        <FormField label="Clinic name" htmlFor="business-name">
          <Input id="business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        </FormField>
        <FormField label="Logo URL" htmlFor="logo-url" helperText="From the admin directory, or your own hosting.">
          <Input id="logo-url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://" />
        </FormField>
      </FormSection>

      <FormSection
        title="Receiving addresses"
        helperText="One address per chain for accepting crypto payments. Leave blank to not accept that chain."
      >
        {paymentChainKeys.map((key) => (
          <FormField key={key} label={paymentChainLabels[key]} htmlFor={`receiving-${key}`}>
            <Input
              id={`receiving-${key}`}
              placeholder="0x..."
              value={receiving[key]}
              onChange={(e) => setReceiving((prev) => ({...prev, [key]: e.target.value.trim()}))}
            />
          </FormField>
        ))}
      </FormSection>

      <FormSection title="Chain RPC overrides" helperText="Leave blank to use the built-in public defaults.">
        <FormField label="ROAX" htmlFor="rpc-roax">
          <Input id="rpc-roax" value={rpc.roax} onChange={(e) => setRpc((p) => ({...p, roax: e.target.value}))} />
        </FormField>
        {paymentChainKeys.map((key) => (
          <FormField key={key} label={paymentChainLabels[key]} htmlFor={`rpc-${key}`}>
            <Input
              id={`rpc-${key}`}
              value={rpc[key]}
              onChange={(e) => setRpc((p) => ({...p, [key]: e.target.value}))}
            />
          </FormField>
        ))}
      </FormSection>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
