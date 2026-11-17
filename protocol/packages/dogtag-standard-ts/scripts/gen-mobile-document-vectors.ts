// Generate specs/mobile-document-vectors.json - EIP-712 vectors for the two WP4.20 mobile document
// structs (DocumentSubmission, DocumentAccess). Reference implementation: viem's hashTypedData /
// signTypedData. The conformance test (test/mobile_document_vectors.test.ts) recomputes every value
// by hand-rolled EIP-712 encoding, independently of this generator.
import {writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  domainSeparator,
  hashStruct,
  hashTypedData,
  type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// TEST-ONLY key (the secp256k1 private key whose value is 1). Public knowledge; never holds value.
const TEST_PRIVATE_KEY: Hex = "0x0000000000000000000000000000000000000000000000000000000000000001";
// Placeholder DogTag VetIssuer clone address. Not a deployed contract.
const PLACEHOLDER_CLONE: Hex = "0x00000000000000000000000000000000000d0901";
const CHAIN_ID = 135;

const U64_MAX = 2n ** 64n - 1n;
const U256_MAX = 2n ** 256n - 1n;
const B32_MAX: Hex = `0x${"ff".repeat(32)}`;
const B32_ZERO: Hex = `0x${"00".repeat(32)}`;
const WALLET_TYPICAL: Hex = "0x1111111111111111111111111111111111111111";
const WALLET_MAX: Hex = "0xffffffffffffffffffffffffffffffffffffffff";
const WALLET_ZERO: Hex = "0x0000000000000000000000000000000000000000";

const submissionTypes = {
  DocumentSubmission: [
    {name: "wallet", type: "address"},
    {name: "dogTagIdField", type: "uint256"},
    {name: "uploadId", type: "bytes32"},
    {name: "sha256", type: "bytes32"},
    {name: "byteLength", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;
const accessTypes = {
  DocumentAccess: [
    {name: "wallet", type: "address"},
    {name: "nonce", type: "bytes32"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

const submissionDomain = {
  name: "DogTagDocumentSubmission",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: PLACEHOLDER_CLONE,
} as const;
const accessDomain = {
  name: "DogTagDocumentAccess",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: PLACEHOLDER_CLONE,
} as const;

const account = privateKeyToAccount(TEST_PRIVATE_KEY);

const dec = (v: bigint) => v.toString(10);

async function build() {
  const submissionMsgs = [
    {
      name: "typical",
      message: {
        wallet: WALLET_TYPICAL,
        dogTagIdField: 123456789012345678901234567890n,
        uploadId: `0x${"ab".repeat(32)}` as Hex,
        sha256: `0x${"cd".repeat(32)}` as Hex,
        byteLength: 482113n,
        deadline: 1793000000n,
      },
    },
    {
      name: "max_boundary",
      message: {
        wallet: WALLET_MAX,
        dogTagIdField: U256_MAX,
        uploadId: B32_MAX,
        sha256: B32_MAX,
        byteLength: U64_MAX,
        deadline: U64_MAX,
      },
    },
    {
      name: "zero_boundary",
      message: {
        wallet: WALLET_ZERO,
        dogTagIdField: 0n,
        uploadId: B32_ZERO,
        sha256: B32_ZERO,
        byteLength: 0n,
        deadline: 0n,
      },
    },
  ];
  const accessMsgs = [
    {
      name: "typical",
      message: {
        wallet: WALLET_TYPICAL,
        nonce: `0x${"12".repeat(32)}` as Hex,
        deadline: 1793000300n,
      },
    },
    {
      name: "max_boundary",
      message: {wallet: WALLET_MAX, nonce: B32_MAX, deadline: U64_MAX},
    },
    {
      name: "zero_boundary",
      message: {wallet: WALLET_ZERO, nonce: B32_ZERO, deadline: 0n},
    },
  ];

  const subSep = domainSeparator({domain: submissionDomain});
  const accSep = domainSeparator({domain: accessDomain});

  const submission = [];
  for (const m of submissionMsgs) {
    const structHash = hashStruct({data: m.message, primaryType: "DocumentSubmission", types: submissionTypes});
    const digest = hashTypedData({domain: submissionDomain, types: submissionTypes, primaryType: "DocumentSubmission", message: m.message});
    const signature = await account.signTypedData({domain: submissionDomain, types: submissionTypes, primaryType: "DocumentSubmission", message: m.message});
    submission.push({
      name: m.name,
      message: {
        wallet: m.message.wallet,
        dogTagIdField: dec(m.message.dogTagIdField),
        uploadId: m.message.uploadId,
        sha256: m.message.sha256,
        byteLength: dec(m.message.byteLength),
        deadline: dec(m.message.deadline),
      },
      domainSeparator: subSep,
      structHash,
      digest,
      signer: account.address,
      signature,
    });
  }
  const access = [];
  for (const m of accessMsgs) {
    const structHash = hashStruct({data: m.message, primaryType: "DocumentAccess", types: accessTypes});
    const digest = hashTypedData({domain: accessDomain, types: accessTypes, primaryType: "DocumentAccess", message: m.message});
    const signature = await account.signTypedData({domain: accessDomain, types: accessTypes, primaryType: "DocumentAccess", message: m.message});
    access.push({
      name: m.name,
      message: {
        wallet: m.message.wallet,
        nonce: m.message.nonce,
        deadline: dec(m.message.deadline),
      },
      domainSeparator: accSep,
      structHash,
      digest,
      signer: account.address,
      signature,
    });
  }

  return {
    _comment:
      "WP4.20 mobile document EIP-712 vectors (plans/wp4.20-dogtag-verified-records.md section 3.3). " +
      "Generated by packages/dogtag-standard-ts/scripts/gen-mobile-document-vectors.ts with viem; " +
      "verified independently (hand-rolled EIP-712) by test/mobile_document_vectors.test.ts. " +
      "verifyingContract is the PLACEHOLDER clone address 0x00000000000000000000000000000000000d0901, " +
      "not a deployed contract. Every signature is made with the TEST-ONLY private key " +
      "0x0000000000000000000000000000000000000000000000000000000000000001 (public knowledge, never holds value). " +
      "uint256/uint64 message values are decimal strings; signature is 65-byte r||s||v with v in {27,28}. " +
      "digest = keccak256(0x1901 || domainSeparator || structHash).",
    chainId: CHAIN_ID,
    verifyingContract: PLACEHOLDER_CLONE,
    testSigner: {privateKey: TEST_PRIVATE_KEY, address: account.address, note: "TEST ONLY - never a real key"},
    DocumentSubmission: {
      typeString:
        "DocumentSubmission(address wallet,uint256 dogTagIdField,bytes32 uploadId,bytes32 sha256,uint64 byteLength,uint64 deadline)",
      domain: submissionDomain,
      vectors: submission,
    },
    DocumentAccess: {
      typeString: "DocumentAccess(address wallet,bytes32 nonce,uint64 deadline)",
      domain: accessDomain,
      vectors: access,
    },
  };
}

const out = await build();
const path = resolve(__dirname, "..", "..", "..", "specs", "mobile-document-vectors.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path}: ${out.DocumentSubmission.vectors.length} DocumentSubmission + ${out.DocumentAccess.vectors.length} DocumentAccess vectors`);
