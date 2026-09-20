import {describe, expect, it} from "vitest";
import {buildSecondaryOwnerRows} from "@/lib/delegation/ownersCard";

describe("buildSecondaryOwnerRows", () => {
  it("active when this clinic's confirmed add is still active on chain", () => {
    const rows = buildSecondaryOwnerRows([{commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 100}], [], new Set(["0xaa"]));
    expect(rows).toEqual([{commitment: "0xaa", status: "active", clientId: "client-1", addedByClinic: "Clinic A", addedAt: 100, revokedAt: undefined}]);
  });

  it("revoked when the chain no longer shows it active, EVEN IF this clinic never recorded a revoke session (revoked at another clinic)", () => {
    const rows = buildSecondaryOwnerRows([{commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 100}], [], new Set());
    expect(rows[0]).toMatchObject({status: "revoked", clientId: "client-1"});
  });

  it("a commitment active on chain with no local record at all shows as 'added at another clinic' (no clientId)", () => {
    const rows = buildSecondaryOwnerRows([], [], new Set(["0xbb"]));
    expect(rows).toEqual([{commitment: "0xbb", status: "active"}]);
    expect(rows[0]!.clientId).toBeUndefined();
  });

  it("falls back to Mongo's own last-known outcome, honestly suffixed _unverified, when the chain is unreadable", () => {
    const rows = buildSecondaryOwnerRows(
      [
        {commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 100},
        {commitment: "0xbb", clientId: "client-2", clinicName: "Clinic A", at: 100},
      ],
      [{commitment: "0xbb", at: 200}],
      null,
    );
    const byCommitment = Object.fromEntries(rows.map((r) => [r.commitment, r.status]));
    expect(byCommitment["0xaa"]).toBe("active_unverified");
    expect(byCommitment["0xbb"]).toBe("revoked_unverified");
  });

  it("a re-add after revoke (same commitment added twice in this clinic's own history) uses the MOST RECENT add's metadata", () => {
    const rows = buildSecondaryOwnerRows(
      [
        {commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 100},
        {commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 500},
      ],
      [{commitment: "0xaa", at: 300}], // revoked between the two adds
      new Set(["0xaa"]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({status: "active", addedAt: 500});
  });

  it("never drops an active-on-chain commitment even if this clinic's own confirmed-add history disagrees (chain wins)", () => {
    // Mongo thinks 0xaa was revoked (a revoke at t=300 after the add at t=100), but the chain
    // still reports it active (e.g. re-added at another clinic after this clinic's own revoke
    // record was written, or a Mongo write this clinic simply never learned about).
    const rows = buildSecondaryOwnerRows([{commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 100}], [{commitment: "0xaa", at: 300}], new Set(["0xaa"]));
    expect(rows[0]).toMatchObject({status: "active"});
  });

  it("sorts newest-added first", () => {
    const rows = buildSecondaryOwnerRows(
      [
        {commitment: "0xaa", clientId: "client-1", clinicName: "Clinic A", at: 100},
        {commitment: "0xbb", clientId: "client-2", clinicName: "Clinic A", at: 200},
      ],
      [],
      new Set(["0xaa", "0xbb"]),
    );
    expect(rows.map((r) => r.commitment)).toEqual(["0xbb", "0xaa"]);
  });
});
