/**
 * Every ROAX chain write in this repo goes through this one function, so "ROAX only ever accepts
 * legacy transactions" (`src/lib/chains.ts`'s doc comment on `roax`) is enforced in exactly one
 * place rather than each call site remembering to pass `type: "legacy"` itself. Used at every
 * `writeContractAsync` call site that targets ROAX: `issueTag`, `revokeTag`, `reactivateTag`,
 * `recordVerificationZK`.
 */
export function legacyTx<T extends object>(params: T): T & {type: "legacy"} {
  return {...params, type: "legacy"};
}
