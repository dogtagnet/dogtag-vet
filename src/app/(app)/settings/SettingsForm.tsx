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
  const [contactEmail, setContactEmail] = useState(initial.businessProfile?.contactEmail ?? "");
  const [phone, setPhone] = useState(initial.businessProfile?.phone ?? "");
  const [primaryColor, setPrimaryColor] = useState(initial.businessProfile?.primaryColor ?? "");
  const [address, setAddress] = useState({
    line1: initial.businessProfile?.address?.line1 ?? "",
    line2: initial.businessProfile?.address?.line2 ?? "",
    city: initial.businessProfile?.address?.city ?? "",
    region: initial.businessProfile?.address?.region ?? "",
    postalCode: initial.businessProfile?.address?.postalCode ?? "",
    country: initial.businessProfile?.address?.country ?? "",
  });
  const [lat, setLat] = useState(initial.businessProfile?.coordinates?.lat?.toString() ?? "");
  const [lng, setLng] = useState(initial.businessProfile?.coordinates?.lng?.toString() ?? "");
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
          businessProfile: {
            name: businessName || undefined,
            logoUrl: logoUrl || undefined,
            contactEmail: contactEmail || undefined,
            phone: phone || undefined,
            primaryColor: primaryColor || undefined,
            address: Object.values(address).some(Boolean)
              ? {
                  line1: address.line1 || undefined,
                  line2: address.line2 || undefined,
                  city: address.city || undefined,
                  region: address.region || undefined,
                  postalCode: address.postalCode || undefined,
                  country: address.country || undefined,
                }
              : undefined,
            coordinates: lat && lng ? {lat: Number(lat), lng: Number(lng)} : undefined,
          },
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
        <FormField
          label="Booking notification email"
          htmlFor="contact-email"
          helperText="Where a public booking or cancellation notice is sent. Leave blank to skip clinic notifications."
        >
          <Input
            id="contact-email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
        </FormField>
        <FormField label="Public phone" htmlFor="business-phone" helperText="Shown on the public entity card.">
          <Input id="business-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormField>
        <FormField
          label="Brand color"
          htmlFor="primary-color"
          helperText="Accent color for the public entity card, e.g. #2563eb."
        >
          <Input
            id="primary-color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            placeholder="#2563eb"
          />
        </FormField>
      </FormSection>

      <FormSection
        title="Address and location"
        helperText="Shown on the public entity card. Coordinates default to 0,0 until set - enter real ones before going live."
      >
        <FormField label="Address line 1" htmlFor="address-line1">
          <Input id="address-line1" value={address.line1} onChange={(e) => setAddress((p) => ({...p, line1: e.target.value}))} />
        </FormField>
        <FormField label="Address line 2" htmlFor="address-line2">
          <Input id="address-line2" value={address.line2} onChange={(e) => setAddress((p) => ({...p, line2: e.target.value}))} />
        </FormField>
        <FormField label="City" htmlFor="address-city">
          <Input id="address-city" value={address.city} onChange={(e) => setAddress((p) => ({...p, city: e.target.value}))} />
        </FormField>
        <FormField label="Region or state" htmlFor="address-region">
          <Input id="address-region" value={address.region} onChange={(e) => setAddress((p) => ({...p, region: e.target.value}))} />
        </FormField>
        <FormField label="Postal code" htmlFor="address-postal">
          <Input
            id="address-postal"
            value={address.postalCode}
            onChange={(e) => setAddress((p) => ({...p, postalCode: e.target.value}))}
          />
        </FormField>
        <FormField label="Country" htmlFor="address-country" helperText="ISO 3166-1 alpha-2, e.g. US.">
          <Input
            id="address-country"
            value={address.country}
            maxLength={2}
            onChange={(e) => setAddress((p) => ({...p, country: e.target.value.toUpperCase()}))}
          />
        </FormField>
        <FormField label="Latitude" htmlFor="address-lat">
          <Input id="address-lat" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="0" />
        </FormField>
        <FormField label="Longitude" htmlFor="address-lng">
          <Input id="address-lng" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="0" />
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
