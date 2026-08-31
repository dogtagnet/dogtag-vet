/**
 * The ONLY form of a client's name a public route (`GET /w/:token`) may ever return - plans/
 * wp4.2-client-wallet-registration.md's dogtag-vet section 4: "masked name only, NEVER raw PII
 * (mask: first letter per word + asterisks)". Every other client field (email, phone, address)
 * never leaves the server at all on that route; only this masked name and the opaque `clientHash`
 * commitment do. See docs/client-wallet-registration.md's trust-model section.
 */
export function maskClientName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0] + "*".repeat(word.length - 1))
    .join(" ");
}
