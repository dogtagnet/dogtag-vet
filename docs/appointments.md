# Appointments

This document covers the appointment-tagging model added in WP4.3: tagging an appointment to one client and any number of pets, the walk-in fallback, the detail page's status lifecycle, and the validation invariants a caller of the API needs to know about.
For the calendar UI itself (grid, click-to-create) see the code in `src/components/calendar/CalendarView.tsx`.
This document is about the data model and the wire contract.

## The tagging model

An appointment is either **tagged** or a **walk-in** - never a mix, and never partially one or the other:

- **Tagged**: `clientId` is a real client's id, and `petIds` is a non-empty array of that client's pets.
  The server derives the denormalized `clientName`/`petName` strings from the live `Client`/`Pet` records - `clientName` is the client's `name`, and `petName` is every tagged pet's `name` joined with `", "`.
- **Walk-in**: `clientId` is absent and `petIds` is empty.
  `clientName`/`petName` are free text supplied directly (the calendar dialog's "Walk-in (no client record)" toggle shows the two plain-text inputs staff already know).

`clientName` and `petName` are required, non-blank fields on every appointment document, tagged or not - there is no third "blank" state.
This is why tagging is all-or-nothing: a client tagged with zero pets, or pets tagged with no owning client, would have nothing coherent to put in the field that has to be there regardless.

### Every write path funnels through the same two chokepoints

Whatever creates or mutates an appointment - the staff calendar's click-to-create dialog, the generic staff API, a retag from the detail page's Edit-tagging section, public booking - ends up going through:

1. **`lifecycle.ts`'s `createAppointment`** for creation, so the capacity-bucket ledger (`CapacityBucket`) and the availability read path never drift apart.
   Staff creates are never capacity-blocked (`enforceCapacity: false`).
   Public bookings are (`enforceCapacity: true`).
2. **`appointmentTagging.ts`'s `resolveTagging`** whenever a tag is being set, changed, or cleared, so `clientName`/`petName` are rebuilt the same way everywhere and the same ownership check applies everywhere.

`resolveTagging` is a thin, DB-touching orchestration layer around two pure, unit-tested pieces:

- **`petsBelongToClient(clientId, petIds, ownerClientIdsByPetId)`**: every tagged pet's `ownerClientIds` must contain the tagged client's id.
  A pet can have more than one owner (`Pet.ownerClientIds` is many-to-many) - this checks membership, not exclusivity, so a shared pet passes for any of its owners.
- **`deriveAppointmentDisplayNames(current, change)`**: rebuilds `clientName`/`petName` from already-resolved strings.
  Untagging (`clientId`/`petIds` explicitly cleared) **freezes** the previous display strings rather than blanking them - there is no free-text input on an untag action, so there is nothing else this could correctly produce, and the fields must stay non-blank regardless.
  The practical effect: a once-tagged, now-untagged appointment keeps showing its last-known client/pet names as plain text.
  What actually changes on untag is that the names stop being **links** - every "is this tagged?" decision in the UI (the appointments list, the detail page's "Tagged to" panel) keys off `clientId`/`petIds` presence, never off whether `clientName`/`petName` happen to be non-empty.

### The symmetric tagging invariant

A tagged client always has at least one pet, and pets are never tagged without an owning client - `Boolean(resultingClientId) === (resultingPetIds.length > 0)` always holds, checked against the **resulting** state (the new value if this request changes that side, else whatever the appointment already had).

One consequence worth calling out explicitly: **a request that nulls out `clientId` must also send `petIds: []` in the same request.**
There is no server-side auto-clearing of the other side - sending only `{clientId: null}` while the appointment still has non-empty `petIds` is rejected (the resulting pair would violate the invariant), and sending only `{petIds: []}` while the appointment still has a `clientId` is rejected the same way.
The UI's "Untag" action (the Edit-tagging section with no client selected) always sends both together for exactly this reason.

Retagging to a different client re-validates **every** tagged pet against the **new** client, even if the request didn't mention `petIds` at all - a retag that keeps its old `petIds` unmentioned must not silently keep pointing at the previous client's pets.
In practice the pickers prevent this from ever happening through the UI: `PetMultiPicker` clears its selection the moment the client it's scoped to changes, so retagging always re-picks pets that belong to the new client before the Edit-tagging section's "Save tagging" button is even enabled.
A direct API call that tries to keep stale pets anyway gets a `400`.

## Status lifecycle

Six statuses, unchanged from before this WP: `scheduled`, `confirmed`, `in_progress`, `completed`, `cancelled`, `no_show`.
What's new is a real transition graph (`src/lib/booking/appointmentStatusGuard.ts`) driving both the detail page's action buttons and a server-side guard on `PATCH /api/appointments/:id`:

| From | Actions available |
| --- | --- |
| `scheduled` | Confirm -> `confirmed`, Start -> `in_progress`, Cancel -> `cancelled`, No-show -> `no_show` |
| `confirmed` | Start -> `in_progress`, Cancel -> `cancelled`, No-show -> `no_show` |
| `in_progress` | Complete -> `completed`, Cancel -> `cancelled` |
| `completed`, `cancelled`, `no_show` | none - terminal |

Every appointment starts `scheduled`, so all five actions are reachable from some point in the lifecycle.
`cancelled`/`no_show` still go through `lifecycle.ts`'s `setAppointmentTerminalStatus`, which releases the capacity buckets the appointment held (idempotently - flipping between the two terminal statuses never double-releases).
A transition the graph doesn't list (e.g. `completed` back to `confirmed`, or a same-status no-op) is rejected with `400`.

Public booking's own cancellation (`POST /v1/booking/appointments/:id/cancel`) is a separate code path with its own `computeCancellable` window check - it does not go through this guard or through `/api/appointments/:id`.

## The PATCH contract

`PATCH /api/appointments/:id` accepts `{status?, clientId?, petIds?, notes?}`, every field independently optional - a caller changes only what it mentions.

`clientId` is **nullable, not just optional**: omitting the key leaves the tag untouched.
`null` is an explicit untag.
A string is a tag or retag.
JSON has no way to send a literal `undefined`, so "key absent" and "explicit `null`" are unambiguous on the wire.
`petIds`, when sent, always **replaces** the full array - there's no add/remove-one shape.

A single PATCH can change status and tagging together (e.g. cancelling and untagging in one save).
The response always reflects a fresh read taken after both have applied, not a partial view from either write.

## Validation invariants, summarized

- `clientName`/`petName` are always non-blank - tagged (derived from records) or walk-in (free text), never neither.
- A tagged client always has >= 1 pet.
- Pets are never tagged without a client (`isTaggingConsistent`).
- Every tagged pet's `ownerClientIds` contains the tagged `clientId` (`petsBelongToClient`) - re-checked whenever either side of the tag changes, even if only one side was mentioned in the request.
- Untagging freezes `clientName`/`petName` rather than blanking them.
- A status transition must be one the graph above lists.
- `cancelled`/`no_show` release capacity exactly once.
- `petIds` defaults to `[]` on every newly created appointment, but - like `Client.wallets` before it - mongoose's `default` only fires at document-creation time, so every read site treats it as `petIds ?? []` rather than trusting the type alone.
