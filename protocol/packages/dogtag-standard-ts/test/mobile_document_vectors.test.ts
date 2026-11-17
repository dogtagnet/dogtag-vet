// Conformance gate for specs/mobile-document-vectors.json (WP4.20S S2): the two EIP-712 structs the
// DogTag mobile document flow signs (DocumentSubmission, DocumentAccess). Every domainSeparator,
// structHash and digest is recomputed here with a HAND-ROLLED EIP-712 encoding (keccak256 of the type
// string, abi.encode of typeHash plus the fields, 0x1901 prefix) - deliberately NOT viem's
// hashTypedData/hashStruct/domainSeparator, which the generator used. Signature recovery uses viem's
// recoverAddress on the independently recomputed digest.
import {describe, it, expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {
  concat,
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  stringToBytes,
  type Hex,
} from "viem";

const VECTORS_PATH = resolve(__dirname, "..", "..", "..", "specs", "mobile-document-vectors.json");

const SUBMISSION_TYPE =
  "DocumentSubmission(address wallet,uint256 dogTagIdField,bytes32 uploadId,bytes32 sha256,uint64 byteLength,uint64 deadline)";
const ACCESS_TYPE = "DocumentAccess(address wallet,bytes32 nonce,uint64 deadline)";
const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

interface Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}
interface Vector {
  name: string;
  message: Record<string, string>;
  domainSeparator: Hex;
  structHash: Hex;
  digest: Hex;
  signer: Hex;
  signature: Hex;
}
interface StructBlock {
  typeString: string;
  domain: Domain;
  vectors: Vector[];
}
interface VectorFile {
  chainId: number;
  verifyingContract: Hex;
  testSigner: {privateKey: Hex; address: Hex};
  DocumentSubmission: StructBlock;
  DocumentAccess: StructBlock;
}

const file = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorFile;

const th = (s: string): Hex => keccak256(stringToBytes(s));

function domainSeparator(d: Domain): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "bytes32"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint256"}, {type: "address"}],
      [th(DOMAIN_TYPE), th(d.name), th(d.version), BigInt(d.chainId), d.verifyingContract],
    ),
  );
}

function submissionStructHash(m: Record<string, string>): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {type: "bytes32"},
        {type: "address"},
        {type: "uint256"},
        {type: "bytes32"},
        {type: "bytes32"},
        {type: "uint64"},
        {type: "uint64"},
      ],
      [
        th(SUBMISSION_TYPE),
        m.wallet as Hex,
        BigInt(m.dogTagIdField),
        m.uploadId as Hex,
        m.sha256 as Hex,
        BigInt(m.byteLength),
        BigInt(m.deadline),
      ],
    ),
  );
}

function accessStructHash(m: Record<string, string>): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "bytes32"}, {type: "address"}, {type: "bytes32"}, {type: "uint64"}],
      [th(ACCESS_TYPE), m.wallet as Hex, m.nonce as Hex, BigInt(m.deadline)],
    ),
  );
}

const digestOf = (sep: Hex, structHash: Hex): Hex => keccak256(concat(["0x1901", sep, structHash]));

const structs = [
  {key: "DocumentSubmission" as const, type: SUBMISSION_TYPE, domainName: "DogTagDocumentSubmission", hash: submissionStructHash},
  {key: "DocumentAccess" as const, type: ACCESS_TYPE, domainName: "DogTagDocumentAccess", hash: accessStructHash},
];

describe("mobile document vectors file shape", () => {
  it("pins the placeholder clone, chain id and test signer", () => {
    expect(file.chainId).toBe(135);
    expect(file.verifyingContract).toBe("0x00000000000000000000000000000000000d0901");
    expect(file.testSigner.privateKey).toBe(`0x${"00".repeat(31)}01`);
  });

  for (const s of structs) {
    it(`${s.key}: pins the exact type string and domain`, () => {
      const block = file[s.key];
      expect(block.typeString).toBe(s.type);
      expect(block.domain).toEqual({
        name: s.domainName,
        version: "1",
        chainId: 135,
        verifyingContract: "0x00000000000000000000000000000000000d0901",
      });
    });

    it(`${s.key}: has typical, max and zero boundary vectors`, () => {
      expect(file[s.key].vectors.map((v) => v.name)).toEqual(["typical", "max_boundary", "zero_boundary"]);
    });
  }

  it("max boundary vectors really use the integer maxima", () => {
    const max = file.DocumentSubmission.vectors.find((v) => v.name === "max_boundary")!.message;
    expect(BigInt(max.dogTagIdField)).toBe(2n ** 256n - 1n);
    expect(BigInt(max.byteLength)).toBe(2n ** 64n - 1n);
    expect(BigInt(max.deadline)).toBe(2n ** 64n - 1n);
    const maxA = file.DocumentAccess.vectors.find((v) => v.name === "max_boundary")!.message;
    expect(BigInt(maxA.deadline)).toBe(2n ** 64n - 1n);
  });
});

describe("mobile document vectors: independent EIP-712 recomputation", () => {
  for (const s of structs) {
    const block = file[s.key];
    for (const v of block.vectors) {
      it(`${s.key}/${v.name}: domainSeparator, structHash, digest match`, () => {
        const sep = domainSeparator(block.domain);
        expect(v.domainSeparator).toBe(sep);
        const sh = s.hash(v.message);
        expect(v.structHash).toBe(sh);
        expect(v.digest).toBe(digestOf(sep, sh));
      });

      it(`${s.key}/${v.name}: signature is 65 bytes and recovers the declared signer`, async () => {
        expect(v.signature).toMatch(/^0x[0-9a-f]{130}$/);
        const vByte = parseInt(v.signature.slice(130, 132), 16);
        expect([27, 28]).toContain(vByte);
        const recovered = await recoverAddress({hash: digestOf(domainSeparator(block.domain), s.hash(v.message)), signature: v.signature});
        expect(recovered).toBe(v.signer);
        expect(v.signer).toBe(file.testSigner.address);
      });
    }

    it(`${s.key}: the two struct domains are distinct from each other`, () => {
      const other = s.key === "DocumentSubmission" ? file.DocumentAccess : file.DocumentSubmission;
      expect(domainSeparator(block.domain)).not.toBe(domainSeparator(other.domain));
    });
  }
});

describe("mobile document vectors: mutation guards", () => {
  const mutate = (field: string, value: string): string => {
    // Flip the last hex digit / increment decimals: always a different value of the same type.
    if (value.startsWith("0x")) {
      const last = value.slice(-1);
      return value.slice(0, -1) + (last === "0" ? "1" : "0");
    }
    return (BigInt(value) === 0n ? 1n : BigInt(value) - 1n).toString(10);
  };

  for (const s of structs) {
    const block = file[s.key];
    const typical = block.vectors.find((v) => v.name === "typical")!;
    const sep = domainSeparator(block.domain);
    const base = digestOf(sep, s.hash(typical.message));

    for (const field of Object.keys(typical.message)) {
      it(`${s.key}: changing only ${field} changes the digest and breaks signer recovery`, async () => {
        const msg = {...typical.message, [field]: mutate(field, typical.message[field])};
        const d = digestOf(sep, s.hash(msg));
        expect(d).not.toBe(base);
        const recovered = await recoverAddress({hash: d, signature: typical.signature});
        expect(recovered).not.toBe(typical.signer);
      });
    }

    it(`${s.key}: changing verifyingContract, chainId, name or version changes the digest`, () => {
      const sh = s.hash(typical.message);
      const variants: Domain[] = [
        {...block.domain, verifyingContract: "0x00000000000000000000000000000000000d0902"},
        {...block.domain, chainId: 136},
        {...block.domain, name: block.domain.name + "X"},
        {...block.domain, version: "2"},
      ];
      for (const d of variants) {
        expect(digestOf(domainSeparator(d), sh)).not.toBe(base);
      }
    });

    it(`${s.key}: cross-struct replay is impossible (the other struct's domain gives a different digest)`, () => {
      const other = s.key === "DocumentSubmission" ? file.DocumentAccess : file.DocumentSubmission;
      expect(digestOf(domainSeparator(other.domain), s.hash(typical.message))).not.toBe(base);
    });
  }
});
