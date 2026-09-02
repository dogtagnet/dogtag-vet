import {describe, expect, it} from "vitest";
import {
  decideVetWalletBanner,
  operatorStatusBadge,
  operatorStatusExplanation,
  type OperatorStatus,
} from "@/lib/staffRoleTone";

const ALL_STATUSES: OperatorStatus[] = ["whitelisted", "not-whitelisted", "no-address", "not-configured", "unreadable"];

describe("operatorStatusBadge / operatorStatusExplanation", () => {
  it("has a distinct, non-empty label and explanation for every status", () => {
    const labels = new Set<string>();
    for (const status of ALL_STATUSES) {
      const badge = operatorStatusBadge[status];
      expect(badge.label.length).toBeGreaterThan(0);
      labels.add(badge.label);
      expect(operatorStatusExplanation(status).length).toBeGreaterThan(0);
    }
    // "not-configured" and "unreadable" deliberately SHARE the label "Could not verify" (both mean
    // "this app cannot tell you right now") - every OTHER status gets its own distinct label.
    expect(labels.size).toBe(ALL_STATUSES.length - 1);
  });

  it("the not-whitelisted explanation matches Kenneth's own ask (K2) - the one sentence this WP quotes verbatim", () => {
    expect(operatorStatusExplanation("not-whitelisted")).toBe(
      "You are a vet/owner but this address is not whitelisted on the clinic clone - you cannot issue DogTags until an owner adds it under Issuance operators.",
    );
  });

  it("never claims 'cannot issue' for no-address - the chain only cares about the CONNECTED wallet, which the app may not have on record", () => {
    expect(operatorStatusExplanation("no-address")).not.toMatch(/cannot issue/i);
  });

  it("the two unreadable-ish states never claim a definite whitelisted/not-whitelisted fact", () => {
    for (const status of ["not-configured", "unreadable"] as const) {
      const text = operatorStatusExplanation(status);
      expect(text).not.toMatch(/is whitelisted/i);
      expect(text).not.toMatch(/is not whitelisted/i);
    }
  });

  it("whitelisted is the only status with an 'ok' tone", () => {
    for (const status of ALL_STATUSES) {
      if (status === "whitelisted") expect(operatorStatusBadge[status].tone).toBe("ok");
      else expect(operatorStatusBadge[status].tone).not.toBe("ok");
    }
  });
});

describe("decideVetWalletBanner", () => {
  const RECORDED = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("hides entirely when whitelisted, not connected at all", () => {
    const d = decideVetWalletBanner({status: "whitelisted", recordedAddress: RECORDED, isConnected: false});
    expect(d).toEqual({show: false, showStatusIssue: false, showMismatch: false});
  });

  it("hides when whitelisted and the connected wallet matches the recorded one", () => {
    const d = decideVetWalletBanner({
      status: "whitelisted",
      recordedAddress: RECORDED,
      connectedAddress: RECORDED,
      isConnected: true,
    });
    expect(d.show).toBe(false);
  });

  it("matches case-insensitively - a checksum-cased connected address still counts as matching", () => {
    const d = decideVetWalletBanner({
      status: "whitelisted",
      recordedAddress: RECORDED,
      connectedAddress: RECORDED.toUpperCase().replace("0X", "0x"),
      isConnected: true,
    });
    expect(d.show).toBe(false);
  });

  it("shows ONLY the mismatch fact when whitelisted but a DIFFERENT wallet is connected", () => {
    const d = decideVetWalletBanner({
      status: "whitelisted",
      recordedAddress: RECORDED,
      connectedAddress: OTHER,
      isConnected: true,
    });
    expect(d).toEqual({show: true, showStatusIssue: false, showMismatch: true});
  });

  it("shows ONLY the status-issue fact when not-whitelisted and nothing is connected", () => {
    const d = decideVetWalletBanner({status: "not-whitelisted", recordedAddress: RECORDED, isConnected: false});
    expect(d).toEqual({show: true, showStatusIssue: true, showMismatch: false});
  });

  it("shows ONLY the status-issue fact when not-whitelisted and the connected wallet MATCHES the (still not-whitelisted) recorded one", () => {
    const d = decideVetWalletBanner({
      status: "not-whitelisted",
      recordedAddress: RECORDED,
      connectedAddress: RECORDED,
      isConnected: true,
    });
    expect(d).toEqual({show: true, showStatusIssue: true, showMismatch: false});
  });

  it("shows BOTH facts when not-whitelisted AND a different wallet is connected", () => {
    const d = decideVetWalletBanner({
      status: "not-whitelisted",
      recordedAddress: RECORDED,
      connectedAddress: OTHER,
      isConnected: true,
    });
    expect(d).toEqual({show: true, showStatusIssue: true, showMismatch: true});
  });

  it("no-address: shows the status issue; mismatch is never true since there is no recorded address to compare against", () => {
    const d = decideVetWalletBanner({status: "no-address", connectedAddress: OTHER, isConnected: true});
    expect(d).toEqual({show: true, showStatusIssue: true, showMismatch: false});
  });

  it("unreadable: shows the status issue regardless of connection state", () => {
    const d = decideVetWalletBanner({status: "unreadable", recordedAddress: RECORDED, isConnected: false});
    expect(d.show).toBe(true);
    expect(d.showStatusIssue).toBe(true);
  });

  it("not-configured: shows the status issue even with a recorded address on file", () => {
    const d = decideVetWalletBanner({status: "not-configured", recordedAddress: RECORDED, isConnected: false});
    expect(d.show).toBe(true);
    expect(d.showStatusIssue).toBe(true);
  });

  it("a connected wallet with nothing recorded never counts as a mismatch on its own (no-address already covers it)", () => {
    const d = decideVetWalletBanner({status: "no-address", connectedAddress: OTHER, isConnected: true, recordedAddress: undefined});
    expect(d.showMismatch).toBe(false);
  });
});
