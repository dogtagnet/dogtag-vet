# DogTag v2 manual E2E test - ROAX testnet

The full journey: admin deploys the protocol on ROAX, onboards a vet, the vet runs a clinic day (client, pet, appointment), mints a DogTag with your iPhone, and the phone then sees the tag, gets a photo, and finds the vet in the directory.
Steps are marked **[You]** or **[Claude]** - at each **[Claude]** step, paste me what the step asks for and I do the wiring.
Do the parts in order; each part lists what proves it worked.

## Environment (already running - do not start anything)

| Thing | Where |
|---|---|
| Admin portal (your browser) | https://admin.dogtag.roax.net on the workstation deployment (Chrome profile 1, sign in by email link with the ADMIN_EMAILS address) |
| Vet portal (your browser) | https://vet.dogtag.roax.net on the workstation deployment (the laptop clinic is retired) |
| Admin public URL (phone-facing, on-chain) | https://whether-now-aruba-impossible.trycloudflare.com |
| Vet public URL (phone-facing, QR codes) | https://single-brand-some-julian.trycloudflare.com |
| MongoDB | Docker `dogtag-local-mongo`, port 27500 |
| ROAX | chainId 135, RPC https://devrpc.roax.net, explorer https://explorer.roax.net |

If the Mac slept and something is down, tell me "restore the test environment" and I will restart servers and tunnels (tunnel URLs change on restart; I will re-wire them).

**Restart the vet and admin dev servers after pulling code that changes a database model** (a new field, a new collection, a changed schema).
A long-lived `next dev` process keeps its old in-memory model registered even after the file on disk changes underneath it, and writes through that stale model can silently drop the new field instead of failing loudly - this is exactly what happened in the "Signature didn't match" incident below.
Tell me "restart the vet server" (or "restart both servers") before you resume testing after I say I've pulled new code.

## Part 0 - [You] Wallets and funding

1. In Chrome profile 1 (admin), make sure MetaMask has the ROAX network: Settings > Networks > Add network manually: Name `ROAX`, RPC `https://devrpc.roax.net`, Chain ID `135`, Symbol `PLASMA`, Explorer `https://explorer.roax.net`.
2. You need these accounts and PLASMA balances:

| Account | Lives where | Needs PLASMA | Purpose |
|---|---|---|---|
| Admin | MetaMask, profile 1 | ~5 | Deploys every contract, runs the approve stepper |
| Custodian | Anywhere (never signs) | 0 | Constructor arg of the SBT; must differ from Admin |
| Vet | MetaMask, profile 2 | ~1 | The vet entity account AND the mint operator wallet |
| Publisher | I hold the key (`0xb8D5DA2E6d5D8637D93d16bbA4Ae63A027F8cE1C`) | ~0.3 | Lets me publish the discovery set from the CLI (there is no admin UI for it) |

3. Fund Admin, Vet, and the Publisher address above.
4. When funded, tell me and continue.

## Part 1 - [You] Admin deploys the protocol suite

Sign in at https://admin.dogtag.roax.net by email link with the ADMIN_EMAILS address, connect the Admin MetaMask account, and approve the network switch to ROAX if prompted.
The dashboard shows setup banners; we will clear them, but NOT in banner order - follow this order (the banners miss one required step).

Two rules that apply to EVERY deploy below:
- Rule A (seed quirk): a version labeled "Seeded" cannot deploy directly. Open it in the editor, click **Compile**, then **Save as new version**, and deploy that v2. Do this for every contract, including `DogTagERC1967Proxy` (compile+save it once, first).
- Rule B (address recording): the "Record as protocol address" dropdown now preselects the right role (VetIssuer preselects `VetIssuerImpl`); when it cannot tell, it starts EMPTY and the Record button stays disabled until you pick.
  Recording a bare implementation under `EntityRegistry` or `VetIssuerFactory` is refused with an explanation (those roles need the proxy address).
  Still glance at the selected role before clicking Record - it overwrites that role's previous record.
- Address fields (initializer/constructor args, Set default implementation) offer one-click "Use:" chips - the connected wallet plus every recorded protocol address.
  Prefer clicking a chip over pasting; only addresses no card knows yet (e.g. the publisher key in step 8) still need a paste.

GOOD NEWS: Claude has already done every compile and save through the UI for you (all sources have a deployable v2; `Groth16VerifierConsent` was created and compiled; screenshots on file).
Rule A is therefore DONE - if a deploy ever complains about mismatched bytecode, that means a source was re-edited; recompile and save a new version, then deploy that one.
The sources live in the EDITOR's left sidebar (any card's "Open in editor" button), not as cards on /admin/contracts.

Your remaining Part 1 is only the MetaMask clicks, in this order (open each contract via `/admin/contracts` > "Open in editor", pick the LATEST version in the sidebar, and use the deploy panel):

1. **EntityRegistry v2**: **Fresh proxy** tab. Step 1 "Deploy EntityRegistry v2 implementation" (MetaMask tx). Step 2 initialize form: `owner_` = your Admin address, then "Deploy proxy" (MetaMask tx). Record as `EntityRegistry`.
2. **DogTagSBTConsent v2**: constructor form `admin` = Admin address, `custodian_` = Custodian address. Deploy (MetaMask tx). Record as `DogTagSBTConsent`.
3. **VetIssuer v2**: **Implementation only** tab, no args. Deploy. Record as **`VetIssuerImpl`** (the dropdown preselects it).
4. **VetIssuerFactory v2**: **Fresh proxy** tab - NOT "Implementation only" (that deploys an unowned logic contract the platform cannot use; the UI warns if you try to record one).
   Step 1 deploy implementation; step 2 initialize: `owner_` = Admin, `registry_` = the EntityRegistry proxy address (from step 1), `sbt_` = the SBT address (from step 2). Record as `VetIssuerFactory`.
5. **Set the default implementation** (required; no banner mentions it): back on `/admin/contracts`, VetIssuerFactory card > **"Set default implementation"** > click the `VetIssuerImpl` chip to fill the address > MetaMask tx.
   If this panel ever says the owner is `0x0000...0000`, the factory card is pointing at a bare implementation - redo step 4 with the Fresh proxy tab and re-record the proxy.
6. **Groth16VerifierConsent v1**: deploy (no args). Record as `Groth16VerifierConsent`.
7. **VerificationRegistryConsent v2**: 5 constructor args IN THIS ORDER: `core` = EntityRegistry proxy, `sbt_` = SBT, `zk` = Groth16VerifierConsent, `ridx` = VetIssuerFactory proxy, `admin` = Admin. Deploy. Record as `VerificationRegistryConsent`.
8. **ProtocolRegistry v2**: `admin` = Admin, `publisher` = `0xb8D5DA2E6d5D8637D93d16bbA4Ae63A027F8cE1C` (Claude's publisher key), `publishTimelock` = `0`. Deploy. Record as `ProtocolRegistry`.
9. Go to `/admin/settings` > "Admin API URL" > the field is prefilled with this deployment's PUBLIC_BASE_URL > click **"Set adminApiUrl"** (MetaMask tx).

Proof of success: `/admin/contracts` shows an address on all 7 cards, and the settings page shows the on-chain adminApiUrl matching the tunnel URL.
The one banner that stays up is "Publish a ProtocolRegistry discovery set" - that is mine, next.

## Part 2 - [Claude] Wiring - DONE 2026-08-30

Completed against the recorded addresses (no paste needed - the admin DB is the source of truth):
discovery set `dogtag-v2/1` published on ProtocolRegistry `0xcf07...f7f1` (propose `0x3df46591...8501`, execute `0x6409019a...5ab4`, verified active with all six members);
vet `.env.local` filled + vet server/worker restarted; admin indexer worker running (healthz :8090); iOS + Android anchors repointed (commits 3aa5b91 / a1f586e).
Remaining: ONE Xcode GUI Run to install the repointed iOS build.
The original checklist, kept for the UAT runbook:

1. Publish the `dogtag-v2/1` discovery set on ProtocolRegistry from the publisher key (propose + execute, timelock 0).
2. Fill the vet platform's `.env.local` with the four contract addresses (server and NEXT_PUBLIC copies) and restart it.
3. Start the admin indexer worker and the vet worker.
4. Point the iPhone app's bundled config at the new ProtocolRegistry and prepare the build.

Then ONE phone step for you: open `dogtag-ios/DogTag.xcodeproj` in Xcode (I will have it ready), phone plugged in and unlocked, scheme **DogTagFFI**, destination your iPhone, press **Run**.
This installs the fixed, Release-mode app (the black-screen bug is fixed in this build).

On the phone, finish onboarding: your interrupted wallet resumes at **"Set an app password"** (min 8 characters, Face ID toggle on) - or if you prefer a clean start, tell me and I will include a reset.
Proof of success: the app opens to the Home tab; Settings > About shows "Proving files verified".

## Part 3 - [You] Vet applies, admin approves

In Chrome profile 2 (vet):

1. Go to https://admin.dogtag.roax.net and sign in by email link as the clinic's applicant address (dev login never exists on the workstation).
2. Go to `/apply` and complete the 8 steps: Profile (Entity type "Veterinary practice", Legal name, Registration ID), Contacts (email, phone), Addresses (add one full address AND set its map position so the directory gets coordinates), Logo (upload any square-ish image; it crops to 512x512), KYC documents (upload at least one file as kind "registration_doc"), Platform (optional - you can put the vet tunnel URL), Wallet (type or connect your VET MetaMask address), Review > **Submit application**.

In Chrome profile 1 (admin):

3. `/admin/applications` > open the new application > review, then **Approve**.
4. The **On-chain setup** stepper appears; with the Admin wallet connected, run it top to bottom (each is a MetaMask tx):
   Step 1 shows the documents hash (no action).
   Step 2 **"Send addEntity transaction"**.
   Step 3 **"Send deployVet transaction"** (if this reverts, Part 1 step 6 was missed).
   Step 4 **"Send grantRole transaction"**.
   Step 5 whitelist: the vet's account is prefilled - click **"Whitelist"** next to it.
   Step 6 top-up: enter `2` and **"Send top-up"** (funds the clone's gas refunds).
   Step 7 **"Mark entity active"** (app-side, no tx - required for the directory).

Proof of success: the stepper shows every step Done and the "Entity active" badge; in profile 2, `/status` shows Chain status Active and the clone address.

## Part 4 - [You] Vet clinic day

In Chrome profile 2, go to https://vet.dogtag.roax.net and sign in by email link (the first vet-platform sign-in becomes the clinic owner; dev login exists only when DEV_LOGIN=1, never on the workstation).

1. **Setup wizard** (sidebar: Administration > Setup wizard): Connect MetaMask (VET account; approve the ROAX switch), the clone auto-discovers from your wallet, review the status panel (balance ~2 PLASMA, "Whitelisted", "Active"), click **"Save setup"**.
2. **Client**: Clients > New client. Name is the only required field (e.g. "Kenneth Wu", plus your email). **Create client**.
2b. **Register the client's wallet** (WP4.2, optional but worth testing): on the client's detail page, Wallets panel > **Register wallet** > a QR with a 10-minute countdown appears.
   iPhone: Scan tab > scan it > a consent screen shows the clinic name, the masked client name, your wallet address, and the issued-at time in YOUR local timezone > Face ID > **Register**.
   The vet panel flips to the wallet row (Active); expand **Receipt** to see the signed EIP-712 record and try **Download JSON** - `pnpm verify-receipt <file>` in dogtag-vet re-verifies it fully offline.
   NOTE: this needs the phone build that includes wallet registration - do one Xcode Run first (the same Run that picks up the new ProtocolRegistry anchor from Part 2's repoint).
3. **Pet**: Pets > New pet. Name (e.g. "Biscuit"), pick the owner you just created, species/breed/DOB as you like, microchip optional. **Create pet**.
4. **Appointment** (WP4.3): Calendar > click an OPEN time slot today > the "New appointment" modal: search your client in the picker (rows show name - email - phone, so same-named clients are tellable apart), pick one or more of their pets, service, **Create**.
   Then click the appointment chip itself: it now opens a detail page (status actions Confirm/Start/Complete/Cancel/No-show, notes, and an Edit-tagging section) - chips no longer misopen the create dialog.
   For an unregistered client, tick "Walk-in (no client record)" to fall back to free-text names.

Proof of success: the appointment shows on the calendar; the pet page shows a "No tag issued" DogTag card with an "Issue a tag" link.

## Part 5 - [You + phone] Mint the DogTag

1. Vet portal: DogTag > **Issue tag** (or the pet page's "Issue a tag" link). Fill the wizard: pick the client, pick the pet, Owner identity (Full name, 2-letter country like `SG`, ID number), pet profile fields, then **"Start issuance"**.
2. A QR appears with a 10-minute countdown ("Scan with the owner's DogTag app").
3. iPhone: open DogTag > Scan tab > scan the QR.
   Expected sequence on the phone: "Resolving session..." > a Review screen listing the vet-attested details, your identity fields, and the sentence "Your identity stays off chain. The tag's verification history is public." > Continue (a backup-phrase gate appears first if you skipped it) > "Building your tag on this device..." > "Submitting to the vet..." > "Waiting for issuance to complete...".
4. Vet portal: the session flips to **ready** ("The device built and bound its profile tree"). Click **"Issue on chain"** > MetaMask confirms `issueTag` from the VET wallet.
5. Wait for the receipt; the page confirms against the chain and flips to **bound** ("Tag bound successfully").
6. Click **"Sign issuer attestation"** and sign the EIP-712 message in MetaMask.
7. Phone: watch for the subtitle **"Confirming on chain..."** - that is the proof the app verified `profileRoot` on ROAX itself - then the green "Tag minted" screen.
   If the phone timed out while you were clicking (it polls ~3.5 minutes), just check the Home tab - the pet appears once bound.

Proof of success: vet `/tags` lists the tag Active with root and tx; the pet page's DogTag card is filled; the phone Home tab shows the pet with an Active chip.

## Part 6 - [You] Close out and phone features

1. **End the appointment** (WP4.3 - the old devtools workaround is retired): click the appointment on the Calendar or the Appointments list to open its detail page, then use the status buttons: **Start** > **Complete** (Confirm/Cancel/No-show are there too; buttons only offer legal transitions). The badge reads Completed everywhere.
2. **Pet photo (phone)**: Home > tap the pet > tap the photo circle > "Pet photo" > Choose from Library or Take Photo > crop square > it saves. The photo is stored on the phone only, by design (nothing about your pet's image ever leaves the device).
3. **Find the vet (phone)**: Directory tab > pull to refresh. Your clinic appears (name, logo, distance if you allow location). Try the search box and the VET filter chip; tap the row for the detail card.
4. **Book from the phone** (WP4.4 - needs the fresh Xcode Run): on the clinic's detail card tap **Book** > pick the service and a slot > the form pre-selects your pet (picker lists your local pets with their tag ids) and shows the sharing line ("Shares your wallet address and DogTag id with the clinic" - on by default) > confirm with Face ID > booked.
   Vet portal: the new appointment shows **Source: mobile**, and its detail page has a **provenance box** - wallet verified ✓, your tag resolved against the local record, client matched via your registered wallet.
   Phone: the **Bookings** tab now actually works (it was broken pre-WP4.4 - the server never returned the manage token): status shows live, and Cancel works from the phone.
   Bonus checks: cancel it from the phone, then book the identical slot again - it succeeds (the replay guard releases on cancel, and the cancelled row keeps an audit trail).

## Part 7 - Verify the trail

- Admin `/admin/activity`: EntityAdded, VetDeployed, OperatorSet, TagIssued events with tx links (indexer worker must be running - Part 2).
- Admin `/admin/tags`: the tag in the cross-vet index, status active.
- Admin `/admin/balances`: the clone balance (~2 PLASMA minus refunds) and refund spend.
- Vet `/activity` (On-chain activity): TagIssued and the gas refund events.
- Explorer: open any tx link - it lands on https://explorer.roax.net.

## Part 8 - [You + Claude + phone] Share and receive tag data (WP4.9)

New since Part 5-7: a vet can now hand a pet's already-minted tag data to its owner's phone (export), and can now RECEIVE verified tag data from elsewhere and attach it to a pet (import) - both without any chain write.
**Before starting this part, tell me "pull the latest vet code and restart the vet server."**
This part adds new database collections and a new field on existing pets; per this file's own header, a long-lived `next dev` process keeps its old model registered even after the code changes underneath it, and skipping the restart risks the exact silent-drop failure mode the "Signature didn't match" incident above already describes.

Both ceremonies generate a QR the SAME way mint and wallet-registration already do. As of WP4.9M, the DogTag iPhone app HAS real scan screens for both - steps 1 and 2 below now use your actual phone; steps 1b/2b/5 are the mobile-specific proofs WP4.9M's own checklist calls for (device recovery, share, and the "already holds this tag" choice) that steps 1-4 alone do not exercise (a plain link click never runs the phone's own chain/wallet verification, and "Claude standing in" for a POST never runs the phone's biometric gate or its own leaf rebuild). Steps 3-4 still use Claude standing in for the phone where noted, since they are testing the VET-SIDE gate matrix specifically, not the phone.

0. **Prerequisite - does your chosen pet already have a tag-data custody record?**
   Every tag issued or imported BEFORE this version has no `TagArtifact` row yet.
   The Share action hard-refuses for such a pet with "This pet has no tag data on file yet - issue or import a tag first."
   Tell me which pet you want to use for steps 1-2, and I will check whether it already has a custody record.
   If it does not, there are two ways forward: (i) ask me to run the backfill script (`scripts/backfillTagArtifacts.ts`, dry-run first and then write) against this UAT database - a step only you can authorize, never one I run without being asked; or (ii) issue a brand-new tag after the restart (repeat Part 5's issuance for a fresh pet) and use that pet instead, which needs no backfill at all. (This has already been run once for real against this UAT database - Blaze's own record was backfilled - so this step will usually find nothing left to do; it still applies to any OTHER pet that predates this schema and has not been touched since.)
   Steps 1 and 2 below refer to whichever pet this step settles on (e.g. Biscuit from Part 5, only if step 0 confirms Biscuit already has a custody record) - substitute your actual chosen pet throughout.
1. **Export**: open the pet from step 0 - Pets > the pet > the DogTag card > **"Share tag data to owner's phone"**.
   A QR appears with a 10-minute countdown, plus the same URL as a plain clickable link underneath it.
   Proof of success (raw HTTP behavior): open that link in ANY browser tab - it returns the pet's full tag data as JSON once, then a second visit to the exact same link returns "expired or already used".
1b. **Device recovery (phone, the real feature)**: generate a FRESH export QR for the SAME pet (the one from step 1 is now burned), then on your iPhone: DogTag > Scan tab > scan it.
    Expected sequence: "Fetching tag data..." > a confirm screen naming the clinic and the pet > **"Recover this tag"** > "Verifying and recovering..." (this is the phone independently recomputing the root from the disclosed leaves, reading `profileRoot` on ROAX itself, and rebuilding the FULL tree from ITS OWN wallet seed - not merely trusting the vet's claim) > a green "Tag recovered" screen.
    Proof of success: the phone's Home tab now shows this pet (if it was not already local, e.g. after a reinstall) with its real name/species/breed; a second scan of a FRESH export QR for the same pet succeeds again just as cleanly (nothing about the first recovery is "used up" locally).
2. **Import onto a NEW pet (phone, the real feature)**: Pets > (any pet page) > the DogTag card's **"Import tag"** (only offered when the pet has no active tag), or Tags > **"Import tag"** > "Create new pet from verified data" > **Generate code**.
   On your iPhone: DogTag > Scan tab > scan the printed QR. Expected sequence: "Resolving session..." > a screen naming the clinic and showing "a new pet record" as the target > **"Choose a pet"** > pick the pet from step 0 (only pets this phone holds tag data for are listed) > Face ID > "Verifying and sharing..." > "Tag data shared".
   Proof of success: a new pet appears on the vet side with that pet's species/breed filled in and an "External" badge (this clinic verified the data but did not itself issue that root).
2b. **Import onto an EXISTING pet target (phone)**: repeat step 2's QR generation but from an EXISTING pet's own "Import tag" action instead of "Create new pet".
    Proof of success: the phone's confirm screen names that specific pet as the target (not "a new pet record"), and the vet side attaches to it (`created: false`) rather than creating a second pet record.
3. **Conflict banner**: repeat step 2 (either the phone or, to isolate the vet-side gate alone, ask me to stand in with a posted completion) but target an EXISTING pet whose species/breed you first edit to something deliberately wrong.
   Proof of success: the import still succeeds, the pet's own (wrong) value is left untouched, and the pet page shows a "Data mismatch at import time" banner naming exactly the field that disagreed.
4. **Revoked refusal**: ask me to revoke the tag being imported (Tags > Revoke) BEFORE completing the import (either the phone or Claude standing in).
   Proof of success: the import is refused - phone: "This tag has been revoked at the issuing clinic and cannot be shared."; vet side: "this tag has been revoked at the issuing clinic and cannot be imported" - nothing is attached, no partial pet is created.
5. **"This device already holds this tag" (phone, replace-or-keep)**: for the SAME pet you recovered in step 1b, have me start Part 5's issuance wizard again for that EXACT pet (the wizard supports issuing a replacement tag for a pet that already has one) and take it all the way through mint + bind + issue + attestation, exactly like Part 5 - this mints a genuinely NEW `dogTagId` for the same pet (the old one is never reused, since `profileRoot` is write-once on chain). Generate a fresh export QR for the pet's NEW tag and scan it on your phone.
   Proof of success: because the phone already has a LOCAL pet with this exact name (from step 1b, under the OLD `dogTagId`), the confirm screen shows an extra choice instead of the plain "Recover this tag" button - **"Replace [name]'s old record"** or **"Keep both"**. Try "Keep both" first (Home now shows two entries for the same pet name, one per `dogTagId`); scan a fresh export QR again and this time choose "Replace" (Home now shows only the new one - the phone's own record of the OLD tag's secret material is still intact on disk, only the visible Home entry for it is gone).

## Part 9 - [You] A vet registers their own issuance wallet, and sees an honest whitelist status (WP4.7C)

New since Part 8: a vet no longer needs YOU (the owner) to record their wallet address for them - they can do it themselves from their own Settings page, and every issuance surface now tells them plainly whether that address can actually issue, never a guess.
No restart is needed for this part - this WP added no new database fields, only new routes and pages, which a running `next dev` picks up on its own.

1. **Invite a second vet** (a genuinely different person from the owner account you have been using) - vet portal Settings > "Invite by email" > an email you can also sign into (or a second dev-login identity if you are testing locally rather than on real Google/magic-link auth) > role **Vet** > **Invite**.
2. **Sign in as that vet** in a separate browser profile or incognito window (do not stay signed in as the owner) - go to Settings.
   You should see a new **"My issuance wallet"** card, separate from "Practitioner profiles" above it (which still shows YOUR wallet field too, but only an owner can edit another person's row there).
   Proof of success: the card's badge reads **"No address on file"** - not "not whitelisted", since nothing has been recorded yet and the app is honest about not knowing.
3. **Connect the vet's own MetaMask wallet** and click **"Use connected wallet"** on the card (fills the field from that connection), then **Save**.
   Proof of success: the badge flips to **"NOT whitelisted"**, with the exact explanation "you cannot issue DogTags until the DogTag admin approves an operator request for it in the admin portal" - and a matching warning banner now appears at the top of `/tags` and `/tags/issue` for this vet.
4. **Grant the operator** - WP4.16 moved this off the vet portal entirely: the owner's Settings > "Issuance operators" panel is now read-only, naming the DogTag admin portal instead of offering an "Add operator" button.
   See **Part 14** for the real, current procedure (apply in the admin portal, the admin approves) - come back here once that part's step 3 confirms.
5. **Sign back in as the vet** and reload Settings (or `/tags`) - no action needed from them beyond that.
   Proof of success: the card's badge now reads **"Whitelisted"**, and the warning banner on `/tags`/`/tags/issue` is gone.
6. **Optional - clear it**: the vet can also click **"Clear"** on their own card at any time to remove their recorded wallet - this only ever changes the app's own record of the address, never the on-chain operator grant; removing that now also goes through the admin portal (Part 14's "Removal works the same way" note), not a same-page button.

## Part 10 - [You + Claude + phone] Masked export and independent verification (WP4.10V, WP4.10M)

New since Part 9: an owner's data can now be shared with SOME fields withheld ("masked") instead of all-or-nothing, and anyone (not just this clinic) can check whether an arbitrary tag-data document is genuine.
**Before starting this part, tell me "pull the latest vet code and restart the vet server."**
This part adds new fields on two existing database records (`TagArtifact.obfuscatedLeafHashes`, `ArtifactExportSession.mask`); per this file's own header, a long-lived `next dev` process keeps its old model registered even after the code changes underneath it, and skipping the restart risks the exact silent-drop failure mode the "Signature didn't match" incident above already describes.

Steps 1-4 below never need the phone - the picker, the live preview, and the independent-verification page are all vet-portal (browser) features; step 3 originally had me stand in for the phone client, since it did not exist yet.
CORRECTED (WP4.10M): the DogTag iPhone app now sends and receives masked artifacts too - steps 5-7 below exercise the real phone client, on the real device, for both directions (phone shares a masked artifact TO a vet; phone receives a masked artifact FROM a vet into partial custody), plus the phone's own standalone masking feature that needs no vet ceremony at all.
Step 3 is left as originally written (it is still a valid, useful test of the vet's OWN masked-import handling in isolation, the same way Part 8's steps 3-4 remain useful even after the phone half of that ceremony works) - step 6 below is the real-phone equivalent, not a replacement.

1. **Export with masking**: open a pet that already has tag data (Part 8 step 0's same prerequisite applies) - Pets > the pet > the DogTag card > **"Export with masking"** (next to "Share tag data to owner's phone").
   You will see every field this clinic currently holds an opening for, grouped **Pet attributes** / **Owner identity** - check any subset of them (both groups are equally maskable; only the three reserved owner-control values are never shown here at all, since they are never disclosed by any export).
   Proof of success: the **Live preview** below the checkboxes immediately swaps each checked field's plain value for `masked 0x????...????` - nothing round-trips to a server first, so this updates instantly as you check/uncheck boxes.
2. **Get the masked document**: with at least one field checked, use any of **Download JSON**, **Show QR**, or **Copy JSON**.
   Proof of success: whichever you choose, the resulting document's `disclosed` array holds only the UNCHECKED fields (with their real values), and `obfuscatedLeafHashes` holds one hash per CHECKED field - open the JSON and confirm the checked field's value is nowhere in it, only its hash.
   If you used Show QR, scanning it with any QR reader (not necessarily the DogTag app) resolves the same one-time link Part 8's plain export does - a second scan/fetch of the same code returns "expired or already used", exactly like an unmasked export.
3. **Import a masked artifact onto a DIFFERENT pet** (Claude standing in for the not-yet-built phone client): this step reuses the REAL masked JSON you got from step 2 - I never fabricate tag data, since the import ceremony does a LIVE on-chain read of the artifact's actual `profileRoot` and a made-up root or dogTagId would simply fail to verify, the same way Part 8's "verify_failed" step deliberately demonstrates.
   Tell me a target pet that does NOT already have an active tag (the pet from step 1 still has its own original tag active, so it cannot be the target here - "Import tag" only ever offers itself on a pet with no active tag, the same rule step 2 above relies on).
   I will start an import session for that target and complete it with the `disclosed` subset and `obfuscatedLeafHashes` straight from your step-2 JSON, instead of the full `leaves` set Part 8's phone client sends.
   Proof of success: the import still succeeds and verifies (masking changes nothing about whether the root recomputes); the target pet page now shows an info banner **"Some fields are masked by the owner"** naming how many fields (never which ones - this clinic genuinely does not know); a masked field is left blank rather than guessed, and re-opening **"Export with masking"** for this pet shows a note that some fields are "already masked by the owner" and cannot be picked (there is no opening to disclose).
4. **Verify a redacted artifact independently**: DogTag group in the sidebar > **"Verify redacted artifact"** (`/verify/redacted`).
   Paste or upload the JSON you downloaded in step 2 (or any `RedactedTagArtifact` document from anywhere - this page never assumes it came from this clinic) and click **Verify**.
   Proof of success: the Result panel shows a **Verified** badge (green) when the document is genuine and currently anchored on chain, lists exactly the keyPaths it discloses, and states how many fields it masks - try pasting the same document with one character changed inside a `value` field, which should instead show a **Failed** badge (red) and never a false Verified.
5. **Share with masking, from the phone** (WP4.10M - no vet interaction at all for this step): on the phone, open a pet with an active tag - the pet detail screen > **"Share with masking"**.
   You will see the same kind of picker as step 1 (grouped Pet attributes / Owner identity, a note that 3 fields always stay private), except this time it is reading straight off the phone's own local recovery backup, not anything the clinic holds.
   Check a field or two and watch the live preview swap that field's value for its hash immediately, exactly like step 1's proof of success - then try each of the three actions: **Share** (the iOS share sheet, offering a JSON file), **Show QR code**, and **Copy to clipboard**.
   Proof of success: the shared/copied JSON's `disclosed` array holds only the fields you left unchecked, and `obfuscatedLeafHashes` holds one hash per checked field - same shape as step 2's document, this time produced entirely on-device; if you check enough fields that the payload gets small, "Show QR code" renders one, but checking few (or no) fields on a pet with several attributes may instead show "This selection is too large for a QR code" - both are correct, expected outcomes, not a bug, since a QR code has a real fixed capacity a large, mostly-unmasked document can exceed.
6. **Share a masked artifact TO a vet, from the phone** (the real-phone equivalent of step 3): tell me a pet that does NOT already have an active tag, and I will generate an "Import tag" QR for it (same staff action step 3's own target-pet rule requires).
   Scan that QR with the DogTag app and pick the pet you want to share (a different, already-tagged pet on your phone) - the app now shows a **"Choose what to share"** screen with the same picker as step 5, inserted before the biometric prompt.
   Check a field, then tap **Share** (its label says how many fields it will hide once you have checked at least one) and authenticate.
   Proof of success: the app's own success screen shows a note that some fields were hidden from this clinic; on the vet side, the target pet's page shows the same **"Some fields are masked by the owner"** banner step 3's proof describes, this time produced by a real phone rather than me standing in for one.
7. **Receive a masked recovery QR on the phone** (partial custody on the receiving end): repeat step 1 on a DIFFERENT pet (one your phone does not currently hold, or one you are comfortable re-recovering) and mask at least one field, then choose **Show QR** on the vet portal this time - this is the STAFF-initiated `/e/` export QR (a real one-time session), not the phone's own step-5 QR.
   Scan that QR with the DogTag app's device-recovery flow (DogTag > Scan tab - the same flow Part 8 step 1b's export QR uses).
   Proof of success: the app's confirm screen and on-chain verification proceed exactly as an unmasked recovery would (masking never changes whether the root recomputes) - only the success screen differs, showing a note that some fields were hidden by the clinic; opening that pet's own **"Share with masking"** screen afterward (step 5) shows the SAME already-masked fields as unavailable to pick, since this phone never received their openings in the first place.
   CORRECTED (wp4.10M grade round 1, D1 fix): if you instead pick a pet your phone ALREADY holds in full custody (the setup line above's "one you are comfortable re-recovering" case), this masked receive now MERGES with what your phone already has, never replaces it.
   Every field your phone already held an opening for survives even though this new scan discloses fewer of them.
   That pet's name/species/breed on Home never go blank and never fall back to showing the raw tag number in place of a name.
   Only a field NEITHER your phone's existing record NOR this new scan discloses ends up hidden on the success screen's count.
   The setup line's parenthetical is therefore no longer a real data-loss warning - pick a pet your phone does NOT already hold instead if you specifically want to see the plain partial-custody path (nothing existing to merge with) this step originally demonstrated.

## Part 11 - [You + phone] Pet detail: dynamic tag data display (WP4.11)

New since Part 10: the pet detail screen now shows a **"Tag data"** card listing every attribute this device holds an opening for, built directly from whatever the phone's own recovery record holds - never a fixed list of name/species/sex.
This part reuses Part 10's masked-share ceremony (steps 6-7) to prove the DISPLAY side, since Part 10 only proved the share/receive mechanics themselves.

1. **Share masked to the phone**: repeat Part 10 step 7 (a vet-initiated `/e/` export QR) **on a pet your phone does NOT already hold** - step 7's own merge-on-receive path (see its `CORRECTED` paragraph) keeps every opening your phone already has when you re-scan a pet it holds in full custody, so nothing would show as hidden if you pick one of those instead.
   Mask every field EXCEPT `sex` and one owner-identity field (e.g. full name) before generating the QR.
   Scan it with the DogTag app's device-recovery flow, then open the recovered pet's detail screen.
   Proof of success: a **"Tag data"** card appears directly below the Identity card, with a **Pet** section showing **Sex: Male** (capitalized) and an **Owner identity** section showing the one identity field you left disclosed - no other pet attribute rows appear, since this device holds no opening for anything else on this tag.
   Near the bottom of the card, a caption with an eye-slash icon states how many fields were hidden by the clinic, using the same wording Part 10 already shows elsewhere.
2. **Share the same pet fully unmasked**: on the vet portal, generate a fresh `/e/` export QR for the SAME pet with nothing checked (no masking at all), and scan it again on the phone.
   Proof of success: the Tag data card now shows every attribute this pet's tag actually carries (name, species, breed, sex, date of birth, microchip fields, weight if present, and every owner-identity field), and the "hidden by a clinic" caption is GONE entirely - full custody shows no masked-count caption at all.

Labels for known fields come from the same copy the mint review screen already shows, so a name/species/sex row here reads identically to what you saw when minting.
A keyPath this build does not recognize (a future field from a later wave) shows a plain, readable guess at its name instead of disappearing.
If a pet has no recovery record on this device at all, no "Tag data" card appears - the existing "Recovery backup" card already explains that state.

## Part 12 - [You] Practitioner name, title, and government accreditation number (WP4.13)

New since Part 10: a vet's name now splits into first and last name, plus a qualification/title field (e.g. "DVM") and a government accreditation number - either an owner setting these for anyone, or a vet/owner setting their own.
This WP adds new fields to the Staff database record - **before starting this part, tell me "pull the latest vet code and restart the vet server."**

1. **Owner fills in a practitioner's name and title** - vet portal Settings > "Practitioner profiles" > find a vet or owner row (invite one first, same as Part 9 step 1, if you have not already) > fill in **First name**, **Last name**, and **Title / qualification** (e.g. "DVM") - each field saves on its own as you tab or click away from it.
   Proof of success: the card's own header updates to the composed name, e.g. "Jane Smith, DVM"; the staff table above (Staff access) now shows the same composed name in its new **Name** column.
2. **Owner fills in the government accreditation number** - same card, same row > **Government accreditation number** (the placeholder text reads "USDA accreditation number" as an example only - any format is accepted).
   Proof of success: the value saves and is still there after a reload.
   Step 5 below is the real proof that it never leaves this page.
3. **Mark that practitioner bookable and give them some weekly hours** (skip if already done in an earlier part) - check **Bookable** on their card, then use the "Weekly hours" picker further down the page to give them at least one open day.
4. **Switch to per-practitioner scheduling** (skip if already on) - Settings > **Scheduling mode** > **Per practitioner** > **Save booking configuration**.
   Proof of success: Calendar > Day view now shows one column per practitioner - find this practitioner's column and check its header shows the composed name ("Jane Smith, DVM") with a small two-letter initials badge next to it reading "JS", not initials that look like they came from splitting the title into the name.
5. **Check the public booking page shows the composed name, but never the accreditation number** - open the vet public URL from the top of this doc in any browser, no sign-in needed (or your iPhone's booking flow, if this clinic is wired into it), pick a service and a date within this practitioner's hours, and check availability.
   Proof of success: the practitioner picker on that page shows "Jane Smith, DVM" with no app update needed - this is served fresh from the same public API the app already calls.
   Proof of the other half: the accreditation number you entered in step 2 appears nowhere on this page, and nowhere in your browser's network tab for the availability request either - it stays in Settings because the SERVER never sends it, not because the UI merely hides it.
6. **Self-service - sign in as the vet themselves** (a different account from the owner, same as Part 9 step 2) and go to Settings.
   Proof of success: a new **"My profile"** card appears (separate from "My issuance wallet", if that vet already registered a wallet in Part 9), pre-filled with whatever the owner entered in steps 1-2 - edit the title field here and click **Save**, with no owner involved at all.
7. **Optional - clear a legacy name**: if any practitioner on this clinic still shows a name that was set before this WP existed (an old free-text "display name" from before the first/last split), their card shows a small note reading "Currently shown as '...' (legacy display name)" with a **Clear legacy name** button next to it.
   This note and button disappear on their own the moment a first and last name is entered for that person - there is nothing to click in that case.

## Part 13 - [You + phone] Color and government registration id on the Tag data card (WP4.12M, WP4.12V)

New since Part 12: the vet portal's issue wizard and Pet CRM record both gained three optional fields - **Color**, **Government registration id**, and **Registration authority** - and the phone's "Tag data" card (Part 11) shows all three with friendly labels once a tag actually carries them.
WP4.12V adds new fields to the Pet and mint-session database records, the same class of change Part 12 needed a restart for - **before starting this part, tell me "pull the latest vet code and restart the vet server."**

1. **Issue a tag with all three fields filled in** - vet portal, mint a new tag, and in the "Pet profile" section fill in **Color** (e.g. "brown"), **Government registration id** (e.g. an AVS licence number), and **Registration authority** (e.g. "AVS Singapore") before generating the mint QR, then complete the mint on the phone as usual.
   Proof of success: on the phone, open the newly minted pet's detail screen - the **"Tag data"** card (Part 11) now shows a **Color** row, a **Government registration id** row, and a **Registration authority** row, each with the value you entered, using the same friendly labels as every other row on that card, not a raw keyPath guess.
2. **Leave all three blank on a different tag** - mint a second tag with none of the three fields filled in.
   Proof of success: that pet's Tag data card shows no Color, Government registration id, or Registration authority row at all - an optional field left empty at mint time never appears as a blank or placeholder row.
3. **Pick an existing pet in the issue wizard** (the replace flow, or the "Existing pet" dropdown in step 2 of the wizard, for a pet you already gave a color/registration id/registration authority to on its Pet page - see step 5) instead of typing a new pet name.
   Proof of success: the "Pet profile" section's Color/Government registration id/Registration authority inputs prefill from that pet's own record the moment you pick it - the rest of the profile (species, breed, sex, etc.) stays blank for you to fill in fresh, exactly as before this wave.
4. **Try a value over 120 characters** in any of the three inputs, either in the issue wizard or on a Pet's own page (step 5 below).
   Proof of success: the browser will not let you type past 120 characters in the first place - there is nothing further to trigger.
5. **Set or edit these fields directly on a pet's own CRM page**, independently of minting a tag - go to Pets, open any pet, and fill in or change **Color**, **Government registration id**, or **Registration authority** under "Basics", then **Save changes**.
   Proof of success: the values persist after a reload of the pet page - but if that pet already has an issued tag, its Tag data card on the phone does NOT change to match (see the note below).

**A tag's root is fixed at mint time.**
Editing these three fields on a pet's CRM page after its tag was already issued changes the CRM record only - it has no effect on any tag already bound, since a tag's Merkle root (and everything the phone's Tag data card shows) is fixed the moment the owner's device binds it.
To put a new or changed value onto an actual tag, re-issue (the vet portal's "replace" flow) rather than editing the pet record and expecting the existing tag to pick it up.

## Part 14 - [You] Apply for an issuance operator in the admin portal; the admin approves; the vet portal's status flips (WP4.16)

New since Part 12: the vet portal (https://vet.dogtag.roax.net) no longer has its own "Add operator"/"Remove operator" buttons on Settings.
`VetIssuer.addOperator`/`removeOperator` are `onlyFactoryAdmin` on the actual contract, so every attempt that panel ever made to submit one of those itself always reverted on a real chain - Part 9 step 4, if you ran it before this WP, only ever appeared to work because the e2e stub never executes a real chain call.
Granting or revoking issuance access now goes entirely through the DogTag admin portal (https://admin.dogtag.roax.net) instead - this part replaces Part 9 steps 4-6 with the real, working procedure, using the second vet Part 9 already invited.
No restart is needed for either app - this WP changed no database schema in either repo, only UI, already-deployed routes, and documentation.

In Chrome profile 2, still signed in as the clinic owner (`vet@example.com`) but now at `https://admin.dogtag.roax.net/status` (sign in by email link again there if that session has expired):

1. Scroll to the new **"Issuance operators"** section near the bottom of the page.
   Fill in the request form with the SECOND vet's details from Part 9 - first name, last name, title, and government accreditation number if you gave them one (all optional), and their wallet address (required - the exact one you recorded for them in the vet portal).
   Leave **Request type** on "Whitelist this wallet as an issuance operator" and click **Submit request**.
   Proof of success: the request appears in the list above the form with status **Submitted**.

In Chrome profile 1 (admin):

2. Go to `/admin/operator-requests` - the new request is listed here across every clinic, naming this clinic, the practitioner, and the wallet.
   Click through to this clinic's own entity page and find the same request as a pending row inside its "Operators" panel (the admin's own internal entity page names it just "Operators" - "Issuance operators" is the vet portal's Settings panel and the clinic's own public status page, a different screen each time) - that panel, not the cross-clinic queue, is where you actually act on it.
3. With the ADMIN wallet connected (the same one from Part 1/Part 3, the protocol admin's own wallet - never the clinic's), click **"Approve: whitelist"** on the pending row and confirm the `addOperator` transaction in MetaMask.
   Proof of success: once the transaction confirms, the request no longer shows as pending; back on the clinic's own `/status` page the request's status now reads **Approved**, and the public "Whitelisted operators" list on that same page includes the new wallet.

Back with the second vet's own session (the separate browser profile or incognito window Part 9 step 2 used), at `https://vet.dogtag.roax.net`:

4. Reload Settings - no action needed from them beyond that.
   Proof of success: the "My issuance wallet" card's badge flips to **"Whitelisted"** within a few seconds of the admin's transaction confirming (this card runs its own independent on-chain read, the same as every other surface that checks this - there is no shared cache anywhere in this app), the explanatory text switches to "This address is whitelisted on the clinic's clone - you can issue DogTags with it." (it never simply disappears), and the warning banner on `/tags`/`/tags/issue` disappears too.
5. Sign back in as the owner (Chrome profile 2, the vet portal) and check Settings > "Issuance operators" - the same vet's row now reads **Active**, with no button anywhere on this page that caused it.

**Removal works the same way, and is not instant.**
Repeat steps 1-3, choosing **"Remove this wallet's issuance access"** as the request type instead of the whitelist one.
There is no self-service "Remove operator" action anywhere in the vet portal any more, so revoking a vet's issuance access now takes however long the DogTag admin takes to review and approve that request - not something an owner can do instantly the moment a vet leaves.
Demoting a vet's app-side role (or disabling their account) in the vet portal is still immediate and independent of this: do that right away when a vet leaves, and file the on-chain removal request separately, since the app-side role change alone never touches the chain.

## Part 15 - [You + phone + vet] Vaccination records (WP4.14)

**Parts 15 to 17 all run against the SAME candidate build - there is no longer a separate WP4.14-only branch or build.**
Records (WP4.14) and multi-owner (WP4.15) are both merged into one line of development: the phone build for all three Parts is the release build `1.3.0(17)` and the vet server is the mainline deployment on the workstation.

**Status update: the vet-side workstream (plan section 11.2, V0-V8) is now built and tested, closing out what was PENDING V-SIDE below.**
Issuance wizard, Records tab, revoke, the export ceremony, and the records-verify session endpoints all exist on the vet mainline now, each with its own unit, integration, and Playwright coverage (`e2e/vaccination-records.spec.ts`).
Steps 1-4 below (mobile-only, no vet counterpart needed) are unchanged from when this Part was first written.
Steps 5-7 (issue, present-to-a-clinic, revoke) now describe the REAL vet-side flow that shipped, in place of the earlier "once 4.14V ships" placeholders.

**One real discrepancy surfaced while building the vet side, and it affected step 6 specifically: the mobile build's own `RecordVerifyPresentEngine.swift` had guessed a wire contract that did not match what actually shipped.**
The guess was a `/xr/<token>` route with `{clinicName, ttlSecs}` resolving and `{ok, result, disclosedKeyPaths, hiddenCount}` completing.
The real, shipped, spec-formalized contract (`dogtag-protocol` main, `specs/qr-formats.md`'s "Records verify QR" and `specs/vet-public-api.yaml`'s `records-verify` tag) is `/v/<token>` (not `/xr/`), resolving to `{purpose: "RECORD_PRESENT", clinicName, status, ttlSecs}` and completing to `{result: {stage, reason?, issuerClone?, recordType?, validity?, disclosedKeyPaths?, hiddenCount?}}` - there is no top-level `ok` field (the whole `result` object IS the outcome, success or refusal alike), but `hiddenCount` itself is present and matches the guess (an integer, the presented artifact's own `obfuscatedLeafHashes.length`, set regardless of `stage`; a follow-up spec commit added it after the first formalization omitted it, an oversight the vet-side V8 pass caught).
**This has since been fixed on the mobile side**: `RecordVerifyPresentEngine.swift`, its ViewModel, and its View were rewritten to this exact real contract, `hiddenCount` included, so step 6 below now describes the actual mobile behavior rather than a placeholder.

1. **Receive a vaccination record (phone).** Ask me to hand-build one `RecordArtifact`-shaped `/e/{token}` response for Blaze (`artifactType: "record"`, the seven non-maskable leaves plus a few clinical ones like `vaccineProductName`/`batchLotNumber`/`vaccinationDate`/`validUntil`, anchored against the real ROAX chain facts - clone `0x86d9ac6c...`, a whitelisted operator address) and serve it from a scratchpad stand-in the phone's Scan tab can reach (mirrors how Part 8's export/import ceremonies were first proven before the vet portal itself grew scan screens).
   Scan it: DogTag > Scan tab > the `/e/<token>` QR.
   Expected sequence: "Fetching tag data..." > a confirm screen titled **"Receive vaccination record"** naming the clinic, the pet, and the record type - no wallet/Face ID step at any point (a record carries no owner-control material, so there is nothing for a biometric gate to protect) > **"Receive this record"** > "Verifying record..." (the phone independently checks the artifact against the FFI's `verify_record_artifact_json`, then reads `rootIssuer`/`recordTypeOf`/`issuedBy`/the chain id directly off ROAX - never merely trusting the response) > a green **"Record received"** screen.
   Proof of success: Blaze's pet detail screen now shows a **"Vaccination records"** card with one row (the vaccine product name, the vaccination date, a **Valid** badge if `validUntil` is in the future); tapping it opens the record detail screen, which lists every disclosed field with real labels (Disease, Vaccine, Manufacturer, Batch/lot number, Valid from/until, Administered by, etc.), reusing the exact same dynamic-attribute card style as the Part 11 "Tag data" card.
2. **A masked record (phone).** Repeat step 1, but the hand-built response withholds `batchLotNumber` and `vaccineManufacturer` (moved to `obfuscatedLeafHashes`) while keeping the seven non-maskable leaves and `validUntil` disclosed.
   Proof of success: the record still verifies and is received; its detail screen shows every OTHER field plus a "2 fields on this record are hidden" caption (the same `eye.slash.fill` idiom Part 10's masked-export screens already use), and does NOT show Batch/lot number or Manufacturer rows at all.
3. **A record with validity hidden (phone).** Repeat step 1 once more, this time withholding `validUntil` itself (still legal - it is not one of the seven non-maskable keyPaths).
   Proof of success: the Records card and detail screen both show a **"Validity hidden"** badge, never a guessed Valid or Expired - the phone never fabricates a validity verdict for data it was not given.
4. **Expiry boundary (phone).** Repeat step 1 with `validUntil` set to YESTERDAY's date (UTC).
   Proof of success: the record shows **Expired**, not Valid - the cutoff is UTC end-of-day on `validUntil`, independent of your phone's own timezone setting (try changing your phone's timezone in Settings and reopening the pet - the badge must not flip).
5. **Issue a real vaccination (vet + phone).** Vet portal, Blaze's pet page > **Records tab** > **"Issue vaccination record"** > fill in Target disease (`Rabies`), Vaccine product (`Rabvac 3`), Manufacturer, Batch / lot number, Vaccination date, Valid from, and Valid until (everything else is optional) > **"Create draft"** > **"Issue on chain"** (the vet's whitelisted wallet signs `issueRecord(VACCINATION, root)` on ROAX - record type first, root second).
   The row shows "Waiting for the transaction to confirm..." and then flips to active on its own once the chain confirms - there is no separate "Confirm" click.
   Optionally **"Sign issuer attestation"** (the C3 EIP-712 signature) > **"Done"**.
   Proof of success: the Records tab lists the new row (disease, product, vaccination date, a **Valid** validity badge, an **Active** status badge, and a block-explorer link once the anchoring tx is confirmed); exporting it to the phone (**"Export to phone"** > the seven required fields are locked, shown with a lock glyph rather than a checkbox, pick any others to disclose > **"Show QR"**) and receiving it on the phone (step 1's ceremony, now against the REAL vet server) shows the identical card this Part's earlier hand-built steps already proved works.
6. **Present a record to a clinic (vet + phone).** Vet portal > **Verify** (DogTag group in the sidebar) > the **Records** pill next to "Consent (ZK)" and "Redacted document" (or the sidebar's own direct **"Verify vaccination record"** link) > **"Start records verification"** produces a QR, valid 10 minutes.
   On the phone: Scan tab > scan it > **"Present a vaccination record"** > pick Blaze's record from step 1/5 > **"Choose what to show"** (the seven non-maskable fields listed under a locked note; every clinical field has its own toggle) > toggle a couple off > **"Present, hiding 2 fields"**.
   Proof of success: the vet's Records-verify page polls automatically (no refresh needed) and within a couple of seconds shows a result badge - **Valid**, **Expired**, or **Revoked** for a genuine record, or **Failed** / **Chain unreadable** / **Wrong chain** / **Not anchored** for anything else - plus an explanation sentence, the list of which fields were disclosed (by name, e.g. "Target Disease", "Vaccine Product"), and a "2 fields hidden" caption matching the 2 toggled off above; the phone shows its own matching result screen.
   **Wire contract** (see this Part's own header note above for the full story of how this was found): `GET /v/{token}` resolves to `{purpose: "RECORD_PRESENT", clinicName, status, ttlSecs}` - not `/xr/{token}`.
   `POST /v/{token}/complete` takes `{artifact: <the same RecordArtifact JSON /e/{token} serves>}` and returns `{result: {stage, reason?, issuerClone?, recordType?, validity?, disclosedKeyPaths?, hiddenCount?}}` - there is no top-level `ok` field, but `hiddenCount` (an integer, `obfuscatedLeafHashes.length`) IS present, matching the mobile guess.
   `RecordVerifyPresentEngine.swift` has been rewritten to this exact shape, so this step is expected to pass against a real vet server.
7. **Revoke a record (vet + phone).** Vet portal, Records tab > the record from step 5 > pick a reason code from the dropdown next to it > **"Revoke"** (the vet's wallet signs `revokeRecord(root, reasonHash)`).
   Proof of success: the vet side shows it as **Revoked** immediately (both the Status and Validity columns flip - a revoked record never shows Valid just because today is still inside its date window); on the phone, re-receiving the record (scan a FRESH `/e/{token}` export - the phone re-reads the chain's `isValid(root)` only at RECEIVE time, `RecordReceiveEngine.swift`; simply re-opening the pet shows whichever verdict was stored at the LAST receive, `RecordStore.swift`, not a fresh chain read) flips its badge to **Revoked** - never silently staying "Valid", and never refusing to show the record at all (records coexist as history; a revoked one is still visible, just honestly labeled).
   A record already exported to the phone BEFORE revocation stays cryptographically genuine (its Merkle proof never changes) but is no longer valid - presenting that SAME, unmodified export to a clinic's records-verify session (step 6) now correctly shows **Revoked**, not Valid, because verification re-reads the chain live at presentment time rather than trusting anything baked into the export.

## Part 16 - [You + Claude + phone] Add and revoke a secondary owner (WP4.15V + WP4.15M/WP4.15M-2)

New since Part 14: a DogTag can now have distinguishable SECONDARY owners alongside its primary owner, added and revoked by clinic staff through a session-plus-QR ceremony that mirrors tag issuance's own shape.
This part covers the vet-portal half (now on the vet mainline, merged in WP4.17) AND the phone half (the ios mainline, build 1.3.0(17)), whose key-derivation gap wp4.15M-2 closed.
Deployment of the new `DelegationRegistry` contract and the `VetIssuer` 2.1.0 upgrade is Kenneth's own action (`docs/DEPLOY-wp4.15.md` on protocol main, or the fresh-stack `Deploy.s.sol` path of the workstation playbook) - these steps assume that has already happened and `DELEGATION_REGISTRY_ADDRESS` is set in the vet deployment's environment (values-vet.yaml on the workstation).

**Phone side status (wp4.15M-2): the crate-level derivation gap is closed - the ceremony's code path is now complete end to end, but has NOT been click-through verified against a live clinic in this wave.**
The phone app (release build `1.3.0(17)`) recognizes the `/d/<32hex>` QR, resolves the session, and now derives a real delegate `commitment` (`Poseidon2(Ax,Ay)` over a BabyJubJub key, via the vendored crate's `derive_delegate_key_hex` export - wp4.15K/wp4.15M-2) before showing the consent-review screen and signing a `DelegationClaim` with its owner secp256k1 wallet key.
This derivation is proven two ways: `DogTagFFITests.DelegateKeyParityTests` matches it against `docs/DELEGATION.md`'s own two conformance vectors and confirms it differs from the primary owner's own consent key/owner secret for the identical seed+tag (domain separation, with real derived values, not just distinct domain strings); `DelegateKeyDerivationTests` proves an old-core build (no `DogTagFFI.xcframework` linked) still fails the ceremony CLOSED before consuming the clinic's one-shot QR, exactly as it always has.
What this wave did NOT do: run this ceremony against a real, live vet deployment on a real device.
This builder works in the iOS Simulator only, and the shared Mac's Docker/local Mongo was down at the time of this update (an unrelated, already-logged infrastructure incident) - so even the vet-side hand-simulation in step 2 below could not itself be exercised live while writing this.
Step 8 below therefore describes what the CODE now does, cited against the actual source and tests, not a claim that this exact click-through was performed - that live verification is still owed once a device build is installed against a reachable, deployed clinic.

1. **Register a second client's wallet.** Pick (or create) a client who is NOT already this pet's owner, and run Part 0's wallet-registration flow for them (Clients > that client > Wallets panel > "Register wallet" > scan/complete with any test wallet) - a secondary owner must already have a registered wallet before this ceremony can start, exactly like the ceremony's own precondition says.
2. **Add a secondary owner (vet + Claude).** Open the pet you issued a tag for earlier > the **DogTag owners** card > **"Add secondary owner"** > search for and pick the client from step 1 > **"Start"**.
   Proof of success so far: a QR appears, captioned "Scan with the secondary owner's DogTag app", with a visible expiry countdown.
   If you have not yet scanned this QR with a real phone (step 8 below), ask me to complete the device half for you instead: I will fetch `GET /d/{token}` from the QR, derive a throwaway per-tag key pair, sign the `DelegationClaim` EIP-712 struct with that client's registered test wallet, and `POST` it to `/d/{token}/complete` - reproducing what a real phone now does automatically (step 8).
   Proof of success: the panel flips to **"Claim received - ready to add on chain"** with an **"Add on chain"** button.
3. **Submit on chain.** Click **"Add on chain"** - your connected (whitelisted) operator wallet signs `addSecondaryOwner(dogTagIdField, commitment)`.
   Proof of success: "Confirming on chain..." appears, then the panel closes and a "Secondary owner added" toast appears; the DogTag owners card now lists the client from step 1 with an **Active** badge, the clinic that added them, and the date.
4. **Confirm the primary badge is untouched.** The pet's ORIGINAL owner still shows the **Primary** badge exactly as before - adding a secondary never changes who the primary is, and the primary's own tag data, tree, and nullifiers are completely unaffected (nothing about Parts 1-14's own flows should look any different).
5. **Revoke the secondary.** On the same DogTag owners card, find the secondary's row > **"Revoke"** > confirm > your operator wallet signs `revokeSecondaryOwner(dogTagIdField, commitment)`.
   Proof of success: the row flips to a **Revoked** badge (no second ceremony, no QR, no phone step needed for this direction - staff and your wallet alone are enough); reloading the page keeps it revoked.
6. **A secondary added at another clinic (optional, if you have a second clinic deployment).** Repeat step 2 from a DIFFERENT clinic's vet portal against the SAME `dogTagIdField`, then reload the FIRST clinic's DogTag owners card for that pet.
   Proof of success: the newly-added secondary appears there too, labeled **"Added at another clinic"** (this clinic has no local record of who they are, only the chain's own confirmation that they are active) - the count never silently disagrees with what the chain reports.
7. **Optional - the experimental consent-relayer toggle.** Settings > "Consent relayer (experimental)" > enable "Default to the clone as relayer on /verify" (owner-only).
   This does nothing useful yet on a real chain - it changes `/verify`'s relayer to this clinic's own clone, which needs the DogTag admin to separately whitelist via `EntityRegistry.setVerifierCapability` before any such session can actually confirm.
   Proof of success: without that admin grant, starting a `/verify` session with the toggle on refuses cleanly with a `canVerify` message naming the PURPOSE it lacks the grant for (not the clone's own address) - never a silent revert.
8. **[Phone] Scan the SAME `/d` QR from step 2 with a real phone (release build `1.3.0(17)`), before asking me to hand-simulate anything for it.**
   DogTag > Scan tab > scan the QR from step 2.
   Expected sequence, per the code path wp4.15M-2 completed (`DelegationFlowViewModel.resolve()`/`DelegationFlowEngine`, cited above - NOT yet click-through verified live, see this Part's own header note): "Resolving session..." (`GET /d/{token}`, non-consuming) -> a brief moment while the phone derives its own delegate commitment (now a real FFI call, not an always-failing stub) -> the **consent-review screen**, showing the clinic name, pet, and the wallet that will sign -> tap "Sign and Continue" -> Face ID/Touch ID -> "Signing..." -> "Submitting..." (`POST /d/{token}/complete` - consumes the token) -> "Waiting for the clinic to confirm..." (polling `GET /d/{token}/status`) -> once step 3 above confirms on chain, the co-owner bundle arrives and is verified (shape, session-match, data-integrity, live chain root - four checks, all fail-closed, README's own "The co-owner bundle" section) -> **"You're a secondary owner"** success screen.
   Proof of success: the pet now appears on this phone's Home screen (the badge itself is not on the Home-screen list - open the pet); its detail screen shows the **Secondary owner** badge and an Owners card with a real, point-in-time count from this device's own ceremony snapshot (not the primary's honest placeholder - see step 9).
   If instead you see a calm blue "Not available yet" screen, this build's `DogTagFFI.xcframework` was not linked (a `DogTag`-scheme, not `DogTagFFI`-scheme, install) - rebuild and reinstall the `DogTagFFI` scheme; the token is still unconsumed either way (`GET /d/{token}` never consumes it), so the SAME QR can be retried.
   If you see "This session has expired or was already used", step 2 has already been completed against this QR (by me, per step 2's own hand-simulation) - scan a FRESH `/d` QR (repeat step 2's own "Add secondary owner" > "Start") instead.
9. **[Phone] The pet screen's Owners card and "Secondary owner" badge (primary's own device).** Open the SAME pet on the PRIMARY owner's own phone (the one you have been testing Parts 1-14 with, or any phone holding this tag's real recovery backup).
   Proof of success: an **Owners** card appears (below the Tag data card), reading "Secondary owners can be added or removed by your vet clinic. This app cannot yet show a live list here." - an honest statement, not a bug: this app bundles exactly one on-chain address and discovers everything else from it, and there is no discovery path to the new `DelegationRegistry` contract yet (a separate, smaller, contracts/discovery-set gap from step 8's own - flagged for a future wave, not a phone-side fix).
   The primary's screen shows NO "Secondary owner" badge at all - `isSecondaryOnly` (`PetDetailView.swift:250`) is `record == nil && secondaryRecord != nil`, which is false on a primary's own device (its `record` is never nil), so that badge is unreachable there by construction.
   Its backup-state and share-with-masking cards look exactly as they did before this feature - adding it changed nothing about the primary's own screen beyond the one new Owners card.
10. **The co-owner bundle receive pipeline, now reachable by the SAME click-through as step 8.** `DelegationFlowEngine.receiveBundle`'s four checks (shape, session-match, data-integrity, live-chain) and `SecondaryOwnerStore`'s persistence run for real the moment step 8's ceremony reaches "Waiting for the clinic to confirm..." and step 3 above confirms on chain - there is no separate manual step left to reach it once the FFI gap closed.
    It remains ALSO exercised directly by `DelegationFlowEngineTests`/`SecondaryOwnerStoreTests`/`VetAPIModelsTests` (hand-built fakes and fixtures, `xcodebuild test` scheme `DogTagTests`), independent of whether a live click-through has been run.

## Part 17 - [You] Deploy the multi-owner contracts from the admin portal (WP4.15D)

Historically Part 16 said deploying `DelegationRegistry` and the `VetIssuer` 2.1.0 upgrade was Kenneth's own action through a raw forge script; on a fresh workstation stack `Deploy.s.sol` deploys both from birth (playbook step 4), and this Part remains the portal path for upgrading an existing stack.
That gap is now closed: the portal can link against a deployed library, render constructor args from any ABI, and drive every write below through your connected admin wallet - no server signer, no key in any file, exactly like every other deploy in Part 1.
This Part documents that NEW path.
The raw `forge script` path still exists and still works (D9 extended it) - if you ever use it instead, D3's "Record an existing address" panel on `/admin/contracts` (below the clone table) is how its output gets into this app's own bookkeeping, since the app never infers a contract's address by scanning the chain.

Rule A (the seed quirk from Part 1) applies again here: `PoseidonT4` and `DelegationRegistry`'s seeded versions cannot deploy directly (their recorded `bytecodeHash` is a hash of the vendored source, not of anything ever actually compiled through this UI) - open each in the editor, **Compile**, **Save as new version**, and deploy that new version, exactly like every contract in Part 1.

1. **PoseidonT4** (a pinned third-party library, not one of "our" contracts - it never gets a card of its own on `/admin/contracts`; its status only ever surfaces contextually, e.g. the "Requires linking" badge in step 2 below).
   Open it in the editor via any contract card's "Open in editor" sidebar, **Compile**, confirm the version kind dropdown reads **Library**, **Save as new version**, then deploy it (no constructor args) from that version's deploy panel.
   Record as **`PoseidonT4`**.
2. **DelegationRegistry**.
   Open it in the editor, **Compile** - the compile panel now shows a **"Requires linking"** notice naming `PoseidonT4`; once step 1 is recorded, this resolves automatically (no address to paste).
   **Save as new version**, then **Fresh proxy** tab.
   Step 1 constructor args `factory_` = the VetIssuerFactory proxy address, `entityRegistry_` = the EntityRegistry proxy address (both "Use:" chips) - deploy the linked implementation (MetaMask tx).
   Step 2 initialize form: `owner_` = your Admin address - deploy the proxy (MetaMask tx).
   Record as **`DelegationRegistry`**.
3. **VetIssuer 2.1.0**.
   Open VetIssuer in the editor, **Compile**, **Save as new version** (this is the same implementation-only flow as Part 1 step 3 - no constructor args), then deploy.
   Record as **`VetIssuerImpl`** - this REPLACES the 2.0.0 address on that role; the 2.0.0 `ContractVersion` row and every clone still running it are untouched by this step alone.
4. **Set the default implementation** so new clones deploy at 2.1.0: `/admin/contracts` > VetIssuerFactory card > **"Set default implementation"** > the `VetIssuerImpl` chip > MetaMask tx.
   Every clone deployed AFTER this point is capable of delegation from birth, but the approve stepper now has a new step for it (**"Initialize delegation support"**, between "Deploy the issuer clone" and "Grant ISSUER_ROLE") that still needs its own MetaMask transaction, exactly like the deploy step before it.
   Continuing an approval already in progress shows this step the same way any resumed stepper step behaves - nothing to do differently, just one more transaction to sign, in order.
5. **Upgrade existing clones (optional)**.
   A clone approved before this Part is still on 2.0.0 and unaffected by step 4.
   `/admin/contracts` > VetIssuerFactory card > **"Upgrade clones"** > check one or more clones (checking just one is fine - this panel sends one `upgradeClone` transaction per selected clone, in sequence, not a single all-or-nothing batch tx) > paste the 2.1.0 implementation address from step 3 > run it.
6. **Initialize delegation on an upgraded clone**.
   On that entity's page (`/admin/entities/[account]`), the new **Delegation** section (between Operators and Clone balance) shows the clone's version, `DelegationRegistry`/`VerificationRegistry`/max refund, live from chain.
   Immediately after step 5's upgrade, this section still says **"Not initialized"**.
   The same section's **"Send initializeDelegation transaction"** button (factory-owner wallet) wires this clone to the addresses recorded in steps 2/1.
   Proof of success: the section now shows both addresses instead of "Not initialized", and `clone.delegationRegistry()` / `verificationRegistry()` read back non-zero from any chain explorer or console.
   This is the admin-portal half only - Part 16 step 9's phone-side "no discovery path" limitation is a separate, vet/phone-side gap this Part does not touch and cannot fix by itself.
7. **Grant a verifier capability**.
   `/admin/settings` > **"Verifier capabilities"** > type a purpose label (any text your own verifier ecosystem agrees on out of band, e.g. `age-verification` - there is no protocol-defined list, this hashes the label with keccak256 client-side) > pick a relayer address (the "Use:" chips include the connected wallet, every recorded protocol address, AND every deployed clone) > leave **Allowed** checked > send.
   Proof of success: the new grant appears in the list below with its purpose shown as a raw hash - expected, since keccak256 cannot be reversed back to the label and the app never pretends otherwise - and the relayer's address.
   Each listed row's own **"Revoke"** button needs no re-typed label.
8. **Optional - set a clone's max gas refund**.
   Same Delegation section as step 6, "Set max gas refund" - type a PLASMA amount, Update (factory-owner wallet).
   Independent of step 6 - works whether or not delegation has been initialized on that clone yet.

Proof Part 17 is fully done: `/admin/contracts` shows 8 cards (the original 7 from Part 1 plus `DelegationRegistry`; `PoseidonT4` is never a card, by design), the setup dashboard's "Deploy DelegationRegistry" banner is clear, and approving a brand-new entity's stepper now shows its fourth STEP but third WALLET TRANSACTION ("Initialize delegation support", between "Deploy the issuer clone" and "Grant ISSUER_ROLE" - step 1, "Documents hash", signs nothing) - sign it like every other step, then the Delegation section on that entity's own page shows both addresses instead of "Not initialized".

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Phone says "This QR code was not recognized" | The QR is not an https tunnel URL. Tell me - a tunnel likely restarted and I need to re-wire PUBLIC_BASE_URL. |
| Phone stuck on "Resolving session..." | Vet tunnel down or vet server down - tell me, I will restore. |
| Directory tab says "Not published yet" | Discovery set not published or the app still points at the old registry - means Part 2 was not completed for the current addresses. |
| "Recompiling this version produced different bytecode..." on deploy | You deployed a Seeded version directly - apply Rule A (Compile > Save as new version > deploy the new one). |
| deployVet reverts | "Set default implementation" (Part 1 step 6) was skipped. |
| Mint wizard: "Your connected wallet is not a whitelisted operator..." | Approve stepper step 5 was missed, or the vet portal is connected with a different account. |
| Vet setup wizard: "Protocol addresses are not configured" | Part 2 env fill + restart not done yet. |
| No "Confirming on chain..." on the phone | Discovery failed; the mint still succeeds via the vet's own chain read-back, but tell me so I can check the registry pointing. |
| Session stuck at `issuing` after a closed tab | Restart the vet worker (tell me) - boot recovery reconciles it from the chain. |
| Admin activity/tags pages empty | The indexer worker is not running or addresses were not recorded via "Record as protocol address". |
| Wallet panel says "Signature didn't match" but the phone showed success | A long-lived dev server with a stale data model silently dropped the write (the signature was fine). Tell me - I restart the vet server; then Generate a new code and re-scan. |
| "Import tag" or "Share tag data" is missing from a pet page | Share only shows when the pet has an active (non-revoked) tag; Import only shows when it does NOT (no tag yet, or revoked) - each hides itself rather than offering an action guaranteed to fail. |
| Export/import code says "expired or already used" on the FIRST try | Both are one-shot the instant the vet server's code was pulled without a restart - Part 8's own first step. Restart the vet server and generate a fresh code. |
| Issue-tag tx reverted on chain, wizard shows "Transaction failed" | Fixed (WP4.5 track 3): the wizard now sends its own gas estimate plus headroom, so this should no longer happen. If it still does, the session flips itself back to `ready` within a couple of seconds (or on the next worker restart if the tab was closed) - the failed tx stays visible for the audit trail. Just click "Issue on chain" again; no need to touch MetaMask's gas settings or tell me. |
| "My issuance wallet" card or the `/tags` banner says "Could not verify" | The clinic's clone address is not set up yet (run the setup wizard first), or the RPC could not be reached just now - reload after a few seconds; this is never shown as a false "Whitelisted". |
| Part 9's status badge does not flip to Whitelisted within a few seconds of the owner's "Add operator" tx confirming | The status is cached for up to 5 seconds per address to avoid hammering the RPC on every page load - wait a few seconds and reload once more before assuming something is wrong. |
| "Export with masking" shows "Could not load this pet's tag data" | Same prerequisite as Part 8 step 0 - this pet has no `TagArtifact` row yet. Issue or import a tag first, or ask me to check/run the backfill. |
| "Verify redacted artifact" shows "Chain unreadable" for a document you know is genuine | The chain could not be reached just now - this is deliberately distinct from "Failed" (a real read attempt, not a guess). Wait a few seconds and click Verify again; tell me if it persists. |
| The phone's pet detail screen has no "Share with masking" card at all | It only appears once BOTH the phone's local recovery backup AND the pet's issuing-clinic address have resolved (the same "Issued by" row on that screen shows a placeholder until this happens) - wait a moment for the page to finish loading, or reopen the pet page. |
| The phone shows "This selection is too large for a QR code" | A real, expected outcome, not a bug - a QR code has a fixed data capacity, and a mostly-unmasked pet profile with several fields (especially owner-identity fields) can genuinely exceed it. Mask more fields to shrink the payload, or use Share/Copy instead, exactly as the message says. |
| The phone's "Choose what to share" (mask) step never appears when sharing to a vet | Confirm the vet code you scanned is an "Import tag" QR (`/i/...`), not an export QR (`/e/...`) - the mask step is part of the import-to-vet ceremony only; device recovery (export) has no mask step of its own to choose from, since the CLINIC picked what to disclose before generating that code. |
| After the vet saves their own name/title in "My profile" (Part 12 step 6), the "Practitioner profiles" card above it still shows the OLD name until you reload the page | Expected, not a bug: "My profile" and "Practitioner profiles" are separate components on the same page, and only a full reload picks up the other one's edit. Reload the page (or navigate away and back) to see both agree. |
| Scanning a `/d` QR on the phone (Part 16) shows a blue "Not available yet" screen instead of a consent-review screen | [CORRECTED, wp4.15M-2 fix round 1] Since wp4.15M-2, this means the installed build is the plain `DogTag` scheme (`StubDogTagCore`, no `DogTagFFI.xcframework` linked), not the `DogTagFFI` scheme - rebuild and reinstall `DogTagFFI` (same fix Part 16 step 8 itself gives). The derivation itself works on an FFI build; this is a wrong-scheme install, not a crate-level gap. The QR is not consumed either way (`GET /d/{token}` never consumes it), so the same QR can be retried. |
| Scanning a `/d` QR on the phone (Part 16) reaches "Waiting for the clinic to confirm...", then shows "You were added as a secondary owner, but this device could not retrieve your tag data" | [New, wp4.15M-2 fix round 1] The clinic confirmed the ceremony on chain, but the vet server could not build the co-owner bundle (`bundleUnavailable` on the status poll - a missing `TagArtifact`, an unreadable chain read, a missing env var, or the bundle's own self-check failing; see `DelegationFlowViewModel.pollStatus()` and this wave's own N2 note on the tradeoff). The one-shot token is already consumed, so this exact QR cannot be retried - ask the clinic to start a fresh `/d` session (Part 16 step 2). |

## Part 18 - [You + phone + vet] Pay a clinic invoice in PLASMA or RUSD on ROAX (WP4.18)

Runs on the workstation deployment (Kenneth's decision of 2026-09-21 retired the laptop clinic).
Preconditions: the clinic is onboarded (Part 17 and the operator whitelisting), the phone runs the release build with the workstation's registry address, the phone wallet holds a little PLASMA for gas and, for the RUSD case, RUSD minted by the admin key (`docs/DEV-TOKENS.md` in the protocol repo), and the appointment you will invoice exists (Part 11 booking).
ROAX is the only payment chain; confirmations are 2, so a settled payment shows within seconds.

### Clinic side: rails, then an invoice

1. [Vet] **Settings**, card **Receiving addresses**: enter the clinic's ROAX receiving address on the **ROAX (testnet)** row (any wallet the clinic controls; it never signs anything) and save.
   Proof of success: the card shows the address on the ROAX (testnet) row and no other chain row exists.
2. [Vet] **Payments** (left navigation), **New payment**: pick the client and the appointment from Part 11, enter the fiat total (for example 45.00 in the clinic currency), then select the rails to offer.
   Selecting **PLASMA** requires the **Manual rate** field (fiat per PLASMA; there is no price feed on ROAX); selecting **RUSD** prefills the rate with 1.00 when the clinic currency is USD and requires an explicit rate otherwise.
   Save.
   Proof of success: the payment page shows one QR tab per selected rail, each captioned with the exact token amount and the **To** address, and the status reads **Pending**.
3. [Vet] Open the appointment (Appointments, the Part 11 booking).
   Proof of success: the appointment page shows the linked invoice with its status.

### Phone side: pay from the appointment

4. [Phone] **Bookings** tab, tap the invoiced appointment to open its detail (the screen title is the service name).
   Proof of success: an **Invoices** section appears below **Details**, listing the invoice with the fiat amount and currency, the offered symbols (PLASMA, RUSD or both) and a **Pending** badge.
5. [Phone] Tap **Pay** under the invoice.
   When both rails are offered the app asks which asset to pay with; pick one.
   Proof of success: the **Pay request** review screen opens pre-filled with that rail's exact amount, the clinic's receiving address and the ROAX chain, identical in shape to a scanned QR's review screen.
   Negative check: the app refuses to proceed when the payment's chain id is not 135 (it cannot happen on the workstation deployment; the unit tests pin it).
6. [Phone] **Confirm and sign**, then Face ID or Touch ID.
   Proof of success: the **Sent** screen shows the transaction hash, and back on the appointment detail the invoice row shows **Confirming payment...** with a spinner.
7. [Phone] Wait a few seconds; the screen polls on its own (pull to refresh also works).
   Proof of success: the badge flips from **Pending** to **Paid**, the spinner and the **Pay** button disappear.
8. [Vet] Reload the payment page.
   Proof of success: the status reads **Paid** and the **Paid with** panel shows the chain key `roax` and a transaction hash equal to the one the phone showed in step 6; **Copy public link** and open it in a browser: the public pay page offers the receipt link.
9. [Phone, optional] Force-quit and relaunch the app, reopen the appointment.
   Proof of success: the invoice still reads **Paid**.
10. [Both, second asset] Repeat steps 2 to 8 with a new invoice offering only the other asset (RUSD if you paid PLASMA first), so both rails are exercised once.
11. [Both, optional] Create an invoice with a payment deadline in the past, or void one from the vet.
    Proof of success: the phone shows **Expired** or **Cancelled** on its next refresh, with no **Pay** button and no error screen.
12. [Phone] Wallet tab.
    Proof of success: after the RUSD payment the RUSD balance on ROAX is shown and decreased by the invoice amount; adding a custom network by RPC URL and chain id still works (native only), unchanged by this wave.

A payment that never confirms: check that the clinic's vet worker is running (its `/healthz` reports the payment watcher's cursor advancing) and that the amount sent equals the invoice amount exactly; a short transfer is never matched by design.
