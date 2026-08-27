"use client";

import {useMemo, useState} from "react";
import {isAddress, isAddressEqual, zeroAddress} from "viem";
import {useAccount, useBalance, useConnect, useReadContract, useSwitchChain} from "wagmi";
import {Banner} from "@/components/ui/Banner";
import {Button, Input} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {KeyValuePanel} from "@/components/ui/KeyValuePanel";
import {AddressChip} from "@/components/ui/AddressChip";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {entityRegistryAbi, vetIssuerAbi, vetIssuerFactoryAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {publicEnv} from "@/lib/env.public";

const factoryAddress = publicEnv.vetIssuerFactoryAddress as `0x${string}` | "";
const entityRegistryAddress = publicEnv.entityRegistryAddress as `0x${string}` | "";

export function SetupWizard() {
  const {address, isConnected, chainId} = useAccount();
  const {connect, connectors, isPending: isConnecting} = useConnect();
  const {switchChain} = useSwitchChain();
  const snackbar = useSnackbar();
  const [entityInput, setEntityInput] = useState("");
  const [lookupEntity, setLookupEntity] = useState<`0x${string}` | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const wrongNetwork = isConnected && chainId !== roax.id;

  const cloneOfConnected = useReadContract({
    address: factoryAddress || undefined,
    abi: vetIssuerFactoryAbi,
    functionName: "cloneOf",
    args: address ? [address] : undefined,
    query: {enabled: Boolean(factoryAddress && address && !wrongNetwork)},
  });

  const cloneOfEntered = useReadContract({
    address: factoryAddress || undefined,
    abi: vetIssuerFactoryAbi,
    functionName: "cloneOf",
    args: lookupEntity ? [lookupEntity] : undefined,
    query: {enabled: Boolean(factoryAddress && lookupEntity && !wrongNetwork)},
  });

  const connectedIsEntity = Boolean(
    cloneOfConnected.data && !isAddressEqual(cloneOfConnected.data as `0x${string}`, zeroAddress),
  );
  const cloneAddress = connectedIsEntity
    ? (cloneOfConnected.data as `0x${string}`)
    : cloneOfEntered.data && !isAddressEqual(cloneOfEntered.data as `0x${string}`, zeroAddress)
      ? (cloneOfEntered.data as `0x${string}`)
      : undefined;
  const entityAccount = connectedIsEntity ? address : lookupEntity;

  const operatorCheck = useReadContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "operators",
    args: address ? [address] : undefined,
    query: {enabled: Boolean(cloneAddress && address)},
  });

  const entityStatus = useReadContract({
    address: entityRegistryAddress || undefined,
    abi: entityRegistryAbi,
    functionName: "isActive",
    args: entityAccount ? [entityAccount] : undefined,
    query: {enabled: Boolean(entityRegistryAddress && entityAccount)},
  });

  const balance = useBalance({address: cloneAddress, chainId: roax.id, query: {enabled: Boolean(cloneAddress)}});

  const canSave = Boolean(cloneAddress && entityAccount);

  async function handleSave() {
    if (!cloneAddress || !entityAccount) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          entityAccount,
          cloneAddress,
          operatorWallet: address,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      snackbar.show("Setup saved", "ok");
    } catch {
      snackbar.show("Could not save setup - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  const rows = useMemo(
    () => [
      {
        key: "clone",
        label: "Clone address",
        value: cloneAddress ? <AddressChip address={cloneAddress} chain="roax" /> : "Not found",
      },
      {
        key: "entity",
        label: "Entity account",
        value: entityAccount ? <AddressChip address={entityAccount} chain="roax" /> : "Unknown",
      },
      {
        key: "balance",
        label: "PLASMA balance",
        value: balance.data ? `${balance.data.formatted} ${balance.data.symbol}` : "-",
      },
      {
        key: "whitelist",
        label: "Operator whitelist",
        value: operatorCheck.data ? (
          <StatusBadge tone="ok" label="Whitelisted" />
        ) : (
          <StatusBadge tone="danger" label="Not whitelisted" />
        ),
      },
      {
        key: "entity-status",
        label: "Entity registry status",
        value: entityStatus.data ? (
          <StatusBadge tone="ok" label="Active" />
        ) : (
          <StatusBadge tone="danger" label="Inactive or revoked" />
        ),
      },
    ],
    [cloneAddress, entityAccount, balance.data, operatorCheck.data, entityStatus.data],
  );

  if (!factoryAddress) {
    return (
      <Banner tone="warn" title="Protocol addresses are not configured">
        Set <code>NEXT_PUBLIC_VET_ISSUER_FACTORY_ADDRESS</code> and{" "}
        <code>NEXT_PUBLIC_ENTITY_REGISTRY_ADDRESS</code> in your environment, then restart the app.
      </Banner>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {!isConnected && (
        <FormSection title="1. Connect wallet" helperText="Connect the wallet you use to operate this clinic's clone.">
          <Button
            onClick={() => {
              const connector = connectors[0];
              if (connector) connect({connector});
            }}
            disabled={isConnecting || connectors.length === 0}
          >
            {isConnecting ? "Connecting..." : "Connect MetaMask"}
          </Button>
        </FormSection>
      )}

      {isConnected && wrongNetwork && (
        <Banner tone="warn" title="Wrong network">
          Switch your wallet to ROAX (chain {roax.id}) to continue.
          <div className="mt-2">
            <Button variant="secondary" onClick={() => switchChain({chainId: roax.id})}>
              Switch network
            </Button>
          </div>
        </Banner>
      )}

      {isConnected && !wrongNetwork && (
        <>
          <FormSection title="2. Discover this clinic's clone" helperText="Auto-discovered from your connected wallet, or looked up by entity account.">
            <div className="flex items-center gap-2">
              <span className="text-body text-ink-muted">Connected wallet</span>
              <AddressChip address={address as `0x${string}`} chain="roax" />
            </div>
            {!connectedIsEntity && (
              <FormField
                label="Entity account"
                htmlFor="entity-account"
                helperText="Enter the clinic entity's account address if your connected wallet is an operator wallet, not the entity account itself."
              >
                <div className="flex gap-2">
                  <Input
                    id="entity-account"
                    placeholder="0x..."
                    value={entityInput}
                    onChange={(e) => setEntityInput(e.target.value.trim())}
                  />
                  <Button
                    variant="secondary"
                    disabled={!isAddress(entityInput)}
                    onClick={() => setLookupEntity(entityInput as `0x${string}`)}
                  >
                    Look up
                  </Button>
                </div>
              </FormField>
            )}
          </FormSection>

          {cloneAddress && (
            <FormSection title="3. Review status">
              <KeyValuePanel rows={rows} />
              <div className="mt-4 flex justify-end">
                <Button onClick={handleSave} disabled={!canSave || saving}>
                  {saving ? "Saving..." : "Save setup"}
                </Button>
              </div>
            </FormSection>
          )}
        </>
      )}
    </div>
  );
}
