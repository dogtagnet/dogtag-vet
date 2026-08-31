import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {WalletRegistrationSession} from "@/lib/models/WalletRegistrationSession";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {createRegistrationSession} from "@/lib/registration/createSession";
import {maskClientName} from "@/lib/registration/mask";
import {readRoaxBlockNumber} from "@/lib/chainRead";
import {roax} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/clients/:id/wallet-registrations` - plans/wp4.2-client-wallet-registration.md,
 * dogtag-vet section 3. Staff-only. Snapshots this clinic's current clone address/chainId/display
 * name and this client's masked name onto the session at creation time (see
 * `lib/registration/flow.ts`'s `RegistrationSessionRow` doc comment for why), then defers to
 * `createRegistrationSession` for the fail-closed chain-read + token/clientHash generation.
 *
 * Two preconditions beyond the spec's literal route list, both fail-closed like every other
 * staff-issuance precondition in this app (`lib/mint/preflight.ts`'s own style):
 * - The clinic must have a discovered `cloneAddress` (it is the signed message's
 *   `verifyingContract`/`clinic` - there is nothing to sign against without it).
 * - The clinic must have a configured display name: the trust model is "the owner vouches for the
 *   displayed clinic + masked name" (docs/client-wallet-registration.md) - an empty clinic name
 *   would put nothing on the consent screen for the owner to actually vouch for.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const client = await Client.findOne({clientId: id}).lean<ClientDoc>();
  if (!client) return notFound("Client not found.");

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) {
    return badRequest("This clinic has not completed setup. Discover and save your clone first.");
  }
  const clinicName = settings.businessProfile?.name?.trim();
  if (!clinicName) {
    return badRequest(
      "Set this clinic's name in Settings before registering a wallet - the owner needs to see who they're vouching for.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await createRegistrationSession(
    {clientFields: {name: client.name, email: client.email, phone: client.phone, address: client.address}},
    now,
    readRoaxBlockNumber,
  );
  if (!result.ok) {
    return badRequest("Could not reach the chain to fetch the current block number. Try again shortly.");
  }

  await WalletRegistrationSession.create({
    token: result.token,
    registrationId: result.registrationId,
    clientId: client.clientId,
    clinic: settings.cloneAddress.toLowerCase(),
    chainId: roax.id,
    clinicName,
    maskedClientName: maskClientName(client.name),
    clientHash: result.clientHash,
    issuedAt: result.issuedAt,
    blockNumber: result.blockNumber,
    deadline: result.deadline,
    consumed: false,
  });

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const qr = `${baseUrl.replace(/\/$/, "")}/w/${result.token}`;

  return NextResponse.json(
    {
      token: result.token,
      qr,
      registrationId: result.registrationId,
      ttlSecs: result.deadline - result.issuedAt,
      issuedAt: result.issuedAt,
      blockNumber: result.blockNumber,
    },
    {status: 201},
  );
}
