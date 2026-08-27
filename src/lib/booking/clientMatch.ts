import "server-only";
import {Client, buildClientSearchKey, type ClientDoc} from "@/lib/models/Client";

/**
 * Client match-or-create for public booking, per wp4-vet.md: match an existing client by email or
 * phone (email first, since it's required on every booking; phone as a secondary match for a
 * client who's booked before under a different email), or create a new one. Never updates an
 * existing client's name/phone from the booking form - a public booking is not an invitation for
 * an anonymous caller to silently overwrite a clinic's own CRM record.
 */
export async function findOrCreateClientForBooking(client: {
  name: string;
  email: string;
  phone?: string;
}): Promise<ClientDoc> {
  const email = client.email.trim().toLowerCase();
  const existing = await Client.findOne({
    $or: [{email}, ...(client.phone ? [{phone: client.phone.trim()}] : [])],
  }).lean<ClientDoc>();
  if (existing) return existing;

  const created = await Client.create({
    name: client.name.trim(),
    email,
    phone: client.phone?.trim(),
    petIds: [],
    searchKey: buildClientSearchKey({name: client.name, email, phone: client.phone}),
  });
  return created.toObject();
}
