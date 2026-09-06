import {describe, expect, it} from "vitest";
import {
  decideVetWalletBanner,
  hasExplicitName,
  operatorStatusBadge,
  operatorStatusExplanation,
  practitionerDisplayName,
  practitionerInitials,
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

/**
 * WP4.13 (Kenneth issue 3) - the three-tier composition `practitionerDisplayName` now implements:
 * (1) firstName/lastName [+ ", title"], (2) the deprecated displayName, (3) the email local part.
 */
describe("practitionerDisplayName - tiered composition", () => {
  it("tier 1: firstName + lastName alone, no title", () => {
    expect(practitionerDisplayName({firstName: "Jane", lastName: "Smith", email: "x@example.com"})).toBe("Jane Smith");
  });

  it("tier 1: firstName + lastName + title appends ', Title'", () => {
    expect(practitionerDisplayName({firstName: "Jane", lastName: "Smith", title: "DVM", email: "x@example.com"})).toBe(
      "Jane Smith, DVM",
    );
  });

  it("tier 1: only firstName set still composes (no trailing space, no lastName gap)", () => {
    expect(practitionerDisplayName({firstName: "Jane", email: "x@example.com"})).toBe("Jane");
  });

  it("tier 1: only lastName set still composes, with title", () => {
    expect(practitionerDisplayName({lastName: "Smith", title: "DVM", email: "x@example.com"})).toBe("Smith, DVM");
  });

  it("tier 1 takes priority over the deprecated tier-2 displayName", () => {
    expect(
      practitionerDisplayName({firstName: "Jane", lastName: "Smith", displayName: "Legacy Name", email: "x@example.com"}),
    ).toBe("Jane Smith");
  });

  it("tier 2: the deprecated displayName, when no firstName/lastName is set", () => {
    expect(practitionerDisplayName({displayName: "Dr. Rivera", email: "x@example.com"})).toBe("Dr. Rivera");
  });

  it("a title never attaches to tier 2 - only tier 1's real first/last fields ever show a title", () => {
    expect(practitionerDisplayName({displayName: "Dr. Rivera", title: "DVM", email: "x@example.com"})).toBe("Dr. Rivera");
  });

  it("tier 3: the email local part, when neither tier 1 nor tier 2 applies - the fallback two e2e specs depend on", () => {
    expect(practitionerDisplayName({email: "dr.rivera@example.com"})).toBe("dr.rivera");
  });

  it("a lone title with nothing else never appears at all - tier 3 ignores it", () => {
    expect(practitionerDisplayName({title: "DVM", email: "solo@example.com"})).toBe("solo");
  });
});

/**
 * WP4.13 - `practitionerInitials` derives initials from the SAME raw fields
 * `practitionerDisplayName` composes from, never by splitting that function's own (possibly
 * titled) output - the calendar trap this WP's plan calls out by name.
 */
describe("practitionerInitials - derived from fields, never from the composed line", () => {
  it("firstName + lastName, ignoring an appended title entirely", () => {
    // `practitionerInitials` has no `title` in its own parameter type (it never reads one) - a
    // plain `const` here (rather than an inline object literal argument) sidesteps TypeScript's
    // excess-property check on the literal while still proving, structurally, that passing a
    // `title` alongside first/last changes nothing about the result.
    const staffWithTitle = {firstName: "Jane", lastName: "Smith", title: "DVM", email: "x@example.com"};
    expect(practitionerInitials(staffWithTitle)).toBe("JS");
  });

  it("the calendar trap: naively splitting the composed (titled) line's own words does NOT give the correct initials", () => {
    const staff = {firstName: "Jane", lastName: "Smith", title: "DVM", email: "x@example.com"};
    const composed = practitionerDisplayName(staff);
    expect(composed).toBe("Jane Smith, DVM");
    const naiveParts = composed.trim().split(/\s+/); // ["Jane", "Smith,", "DVM"]
    const naiveWrongInitials = `${naiveParts[0]?.[0] ?? ""}${naiveParts[naiveParts.length - 1]?.[0] ?? ""}`.toUpperCase();
    // Pinned exactly, not just "not JS": naively taking the first letter of the first word and of
    // the LAST word gives "J" + "D" = "JD" - the title's own initial, standing in for the
    // practitioner's actual last-name initial. (The plan's own prose illustrates this trap with a
    // different wrong pair, "SD" - that specific letter pair is not reproducible from this exact
    // split algorithm; what is load-bearing, and what this test pins, is that SOME wrong pair
    // comes out of splitting the composed line, and that `practitionerInitials` avoids it by
    // never taking that path at all.)
    expect(naiveWrongInitials).toBe("JD");
    expect(naiveWrongInitials).not.toBe("JS");
    expect(practitionerInitials(staff)).toBe("JS");
  });

  it("only firstName set (no lastName) falls back to a 2-letter initial from that single word", () => {
    expect(practitionerInitials({firstName: "Jane", email: "x@example.com"})).toBe("JA");
  });

  it("only lastName set (no firstName) falls back to a 2-letter initial from that single word", () => {
    expect(practitionerInitials({lastName: "Smith", email: "x@example.com"})).toBe("SM");
  });

  it("tier 2 fallback: a multi-word legacy displayName with no comma", () => {
    expect(practitionerInitials({displayName: "Maria Rivera", email: "x@example.com"})).toBe("MR");
  });

  it("tier 2 fallback: strips a ', title' suffix accidentally embedded in a legacy displayName before computing initials", () => {
    expect(practitionerInitials({displayName: "Jane Smith, DVM", email: "x@example.com"})).toBe("JS");
  });

  it("tier 3 fallback: a single-word email local part takes its own first 2 characters", () => {
    expect(practitionerInitials({email: "owner@example.com"})).toBe("OW");
  });

  it("tier 3 fallback: a multi-word (dotted) email local part is not special-cased - dots are not whitespace", () => {
    expect(practitionerInitials({email: "dr.rivera@example.com"})).toBe("DR");
  });
});

describe("hasExplicitName", () => {
  it("true when firstName is set", () => {
    expect(hasExplicitName({firstName: "Jane"})).toBe(true);
  });

  it("true when lastName is set", () => {
    expect(hasExplicitName({lastName: "Smith"})).toBe(true);
  });

  it("true when only the deprecated displayName is set", () => {
    expect(hasExplicitName({displayName: "Dr. Rivera"})).toBe(true);
  });

  it("false when nothing is set - only the email tier would apply", () => {
    expect(hasExplicitName({})).toBe(false);
  });

  it("false for whitespace-only values (trimmed before checking)", () => {
    expect(hasExplicitName({firstName: "   ", lastName: "  ", displayName: " "})).toBe(false);
  });
});
