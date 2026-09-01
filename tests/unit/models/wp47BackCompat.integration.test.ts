import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7 A3 - back-compat proof for every schema addition (Staff.bookable/displayName/
 * walletAddress, AvailabilityRule/AvailabilityException.staffId, BookingSettings.schedulingMode)
 * against documents shaped exactly as they were BEFORE this WP - i.e. what the live UAT database
 * (and any other already-deployed clone) actually has on disk right now, not what a freshly
 * `.create()`-d document looks like (mongoose bakes schema defaults into a document at CREATE
 * time, so a fresh insert would pass even a naive implementation - only inserting the OLD raw
 * shape, bypassing mongoose's own schema/defaulting via `Model.collection.insertOne`, actually
 * exercises the read-back path a real upgrade hits).
 *
 * ISOLATION: own ephemeral `mongod` on a scratch port/dbpath (never `process.env.MONGODB_URI` from
 * the environment, never mongodb://127.0.0.1:27500) - same pattern as
 * `tests/unit/registration/staleModelRepro.integration.test.ts`, whose own doc comment explains
 * the rationale in full. Port 44118 (staleModelRepro already owns 44117).
 *
 * `@/auth` is mocked (not imported for real) so `requireVetSession`/`requireOwnerSession`'s own
 * role x disabled matrix - the actual re-read-from-Mongo logic those functions exist for - can be
 * exercised without constructing a real NextAuth session or hitting a real OAuth/email provider;
 * this file's mongod is what makes their internal `connectToDatabase()` call real rather than
 * itself needing a mock.
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityException, AvailabilityRule, BookingSettings, getBookingSettings} from "@/lib/models/Availability";
import {listStaff, Staff, type StaffDoc} from "@/lib/models/Staff";
import {requireOwnerSession, requireVetSession} from "@/lib/staffApi";

const MONGO_PORT = 44_118; // staleModelRepro already owns 44117.

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47-backcompat");

  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  // Hard safety net, same as staleModelRepro: this process's global mongoose connection must be
  // OUR ephemeral instance, never anything read from a real deployment's environment.
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-wp47-backcompat");

  // Wait for the compound (date, staffId) unique index to actually finish building before any
  // test relies on it rejecting a duplicate - autoIndex runs in the background on model
  // compilation, not synchronously.
  await AvailabilityException.init();
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Staff.deleteMany({});
  await BookingSettings.deleteMany({});
  await AvailabilityException.deleteMany({});
  await AvailabilityRule.deleteMany({});
  vi.mocked(auth).mockReset();
});

describe("Staff back-compat (bookable/displayName/walletAddress)", () => {
  it("a pre-WP4.7 row (raw insert, no new fields in storage) reads back via listStaff() with bookable coalesced to false", async () => {
    await Staff.collection.insertOne({
      staffId: "legacy-owner",
      email: "legacy-owner@example.com",
      role: "owner",
      disabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const list = await listStaff();
    const found = list.find((s) => s.staffId === "legacy-owner");
    expect(found).toBeDefined();
    expect(found!.bookable).toBe(false);
    expect(found!.displayName).toBeUndefined();
    expect(found!.walletAddress).toBeUndefined();
  });

  it("a freshly created Staff row defaults bookable to false and leaves displayName/walletAddress unset", async () => {
    const created = await Staff.create({email: "fresh@example.com", role: "vet"});
    const plain = created.toObject() as StaffDoc;
    expect(plain.bookable).toBe(false);
    expect(plain.displayName).toBeUndefined();
    expect(plain.walletAddress).toBeUndefined();
  });

  it("walletAddress is lowercased on write regardless of input casing (mongoose-level, defense in depth alongside the zod schema)", async () => {
    const created = await Staff.create({
      email: "checksum@example.com",
      role: "vet",
      walletAddress: "0x1234567890abcdef1234567890ABCDEF12345678",
    });
    expect(created.toObject().walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });
});

describe("BookingSettings back-compat (schedulingMode)", () => {
  it("a pre-WP4.7 singleton (raw insert, no schedulingMode in storage) reads back via getBookingSettings() as clinic mode", async () => {
    await BookingSettings.collection.insertOne({
      _id: "singleton",
      timezone: "America/New_York",
      minNoticeMinutes: 60,
      maxAdvanceDays: 60,
      slotGranularityMinutes: 15,
      updatedAt: new Date(),
    } as never);

    const settings = await getBookingSettings();
    expect(settings.schedulingMode).toBe("clinic");
  });

  it("a freshly created singleton defaults schedulingMode to clinic", async () => {
    const settings = await getBookingSettings();
    expect(settings.schedulingMode).toBe("clinic");
  });
});

describe("AvailabilityException - compound (date, staffId) uniqueness on a fresh database", () => {
  it("two different practitioners can each have their own exception on the identical date", async () => {
    await AvailabilityException.create({date: "2026-12-25", closed: true, staffId: "vet-a"});
    await AvailabilityException.create({date: "2026-12-25", closed: true, staffId: "vet-b"});
    const rows = await AvailabilityException.find({date: "2026-12-25"}).lean();
    expect(rows.length).toBe(2);
  });

  it("a practitioner's exception can coexist with a clinic-wide exception on the identical date", async () => {
    await AvailabilityException.create({date: "2026-12-26", closed: true});
    await AvailabilityException.create({date: "2026-12-26", closed: true, staffId: "vet-a"});
    const rows = await AvailabilityException.find({date: "2026-12-26"}).lean();
    expect(rows.length).toBe(2);
  });

  it("still refuses a second clinic-wide exception on a date that already has one - today's exact invariant, unchanged", async () => {
    await AvailabilityException.create({date: "2026-12-27", closed: true});
    await expect(AvailabilityException.create({date: "2026-12-27", closed: false})).rejects.toMatchObject({code: 11000});
  });

  it("still refuses a duplicate (date, staffId) pair for the same practitioner", async () => {
    await AvailabilityException.create({date: "2026-12-28", closed: true, staffId: "vet-a"});
    await expect(AvailabilityException.create({date: "2026-12-28", closed: false, staffId: "vet-a"})).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe("AvailabilityRule - staffId scoping", () => {
  it("multiple practitioners can each have a rule for the identical dayOfWeek (no cross-practitioner uniqueness constraint)", async () => {
    await AvailabilityRule.create({dayOfWeek: 1, startMinute: 540, endMinute: 1020, staffId: "vet-a"});
    await AvailabilityRule.create({dayOfWeek: 1, startMinute: 480, endMinute: 960, staffId: "vet-b"});
    const rows = await AvailabilityRule.find({dayOfWeek: 1}).lean();
    expect(rows.length).toBe(2);
  });

  it("a rule created with no staffId (clinic-wide) leaves it unset, not null or empty string", async () => {
    const created = await AvailabilityRule.create({dayOfWeek: 2, startMinute: 540, endMinute: 1020});
    expect(created.toObject().staffId).toBeUndefined();
  });
});

describe("requireVetSession / requireOwnerSession - role x disabled matrix, re-read from Mongo", () => {
  async function withSession(staffId: string) {
    vi.mocked(auth).mockResolvedValue({user: {staffId, email: "x@example.com"}} as never);
  }

  it.each([
    {role: "vet", disabled: false, expectAllowed: true},
    {role: "owner", disabled: false, expectAllowed: true},
    {role: "staff", disabled: false, expectAllowed: false},
    {role: "vet", disabled: true, expectAllowed: false},
    {role: "owner", disabled: true, expectAllowed: false},
  ] as const)("requireVetSession: role=$role disabled=$disabled -> allowed=$expectAllowed", async ({role, disabled, expectAllowed}) => {
    const staff = await Staff.create({email: `${role}-${disabled}@example.com`, role, disabled});
    await withSession(staff.staffId);

    const result = await requireVetSession();
    if (expectAllowed) {
      expect(result.response).toBeNull();
      expect(result.staff?.staffId).toBe(staff.staffId);
    } else {
      expect(result.response).not.toBeNull();
      expect(result.response!.status).toBe(403);
    }
  });

  it("requireVetSession refuses a session whose staffId matches no Staff row at all", async () => {
    await withSession("does-not-exist");
    const result = await requireVetSession();
    expect(result.response).not.toBeNull();
    expect(result.response!.status).toBe(403);
  });

  it("requireOwnerSession still refuses vet (unchanged by this WP - only owner qualifies)", async () => {
    const staff = await Staff.create({email: "vet-only@example.com", role: "vet", disabled: false});
    await withSession(staff.staffId);
    const result = await requireOwnerSession();
    expect(result.response).not.toBeNull();
    expect(result.response!.status).toBe(403);
  });

  it("a role change takes effect immediately on the NEXT call - proves the re-read, not a cached/trusted token claim", async () => {
    const staff = await Staff.create({email: "promote-me@example.com", role: "staff", disabled: false});
    await withSession(staff.staffId);

    const before = await requireVetSession();
    expect(before.response?.status).toBe(403);

    await Staff.updateOne({staffId: staff.staffId}, {$set: {role: "vet"}});
    const after = await requireVetSession();
    expect(after.response).toBeNull();
  });
});
