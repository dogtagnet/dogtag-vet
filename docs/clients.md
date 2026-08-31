# Clients

This document covers the client record itself: its fields, search, and the optional identification-document fields added in WP4.3.
For the wallet-registration flow a client record also carries, see `docs/client-wallet-registration.md`.
For how clients get tagged onto appointments, see `docs/appointments.md`.

## Fields

A client has one required field: `name`.
Every other field is optional: `email`, `phone`, `address`, `notes`, and the identification-document fields below.

## Identification fields

`idDocType` (one of `passport`, `national_id`, `drivers_license`, `other`) and `idDocNumber` (free text) let staff record which identification document a client presented, and its number.
Both are optional - a clinic that never asks for ID never has to fill them in, and existing clients are unaffected.

The ClientForm shows them under an "Identification" section, with the helper text "Optional - passport, ID card, driver license, or other proof of identity."

### Two deliberate exclusions

These fields are deliberately kept out of two places that otherwise touch every other client field, and this is normative (WP4.3 A2), not an oversight:

1. **`buildClientSearchKey` never reads them.**
   The search key (`src/lib/models/Client.ts`) backs the staff-facing client typeahead (`GET /api/clients?q=`), which does a substring `$regex` match against it.
   An identification-document number must never land in a substring-searchable index - it is exactly the kind of sensitive-but-not-secret value that a "search everything" box should not accidentally expose to anyone who can guess a few digits.
2. **`clientHash` never hashes them.**
   WP4.2's wallet-registration flow (`docs/client-wallet-registration.md`) computes an opaque `clientHash` commitment over a client's `{name, email, phone, address}` fields, which an owner's wallet signs over.
   That shape is baked into every already-issued receipt.
   Adding a field to it would silently change what future receipts commit to while leaving old receipts committing to the old shape - two classes of receipt that look identical but verify differently.
   Identification-document fields therefore sit entirely outside the wallet-registration trust boundary: `src/lib/registration/clientHash.ts`'s `ClientHashFields` type only ever had `{name, address, email, phone}`, and stays that way.

Both exclusions are enforced structurally, not by a runtime check: `buildClientSearchKey` and `ClientHashFields` are typed to only see the three (or four) fields they have always seen, so a caller cannot accidentally widen what either function reads without first widening the type itself.

## Search

`GET /api/clients?q=` matches the denormalized `searchKey` (name + email + phone, lowercased, whitespace-collapsed) with a substring regex.
It is the same index the `ClientPicker` and `PetMultiPicker`'s underlying client search (see `docs/appointments.md`) use to disambiguate same-named clients - the dropdown rows show name, email, and phone so that, for example, two different clients both named "John" are still tellable apart at a glance.
