/** keyHash = Poseidon(Ax, Ay) -> canonical 32-byte big-endian hex (impl §1.10). */
export declare function keyHash(Ax: bigint, Ay: bigint): string;
/** A derived BabyJubjub consent key: private scalar bytes + public point (Ax, Ay) as bigints. */
export interface BabyjubConsentKey {
    prv: Uint8Array;
    Ax: bigint;
    Ay: bigint;
}
/**
 * Derive a BabyJubjub consent keypair from a 32-byte seed (circomlibjs EdDSA private key).
 * Returns the private-key bytes plus the public point A = (Ax, Ay) as field bigints.
 */
export declare function deriveBabyjubConsentKey(seed: Uint8Array): Promise<BabyjubConsentKey>;
//# sourceMappingURL=consent.d.ts.map