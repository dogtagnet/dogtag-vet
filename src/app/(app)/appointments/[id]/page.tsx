import {notFound} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {orderPetsByPetIds} from "@/lib/booking/appointmentTagging";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {getBookingSettings} from "@/lib/models/Availability";
import {listBookablePractitioners} from "@/lib/booking/queries";
import {AppointmentDetailPanel} from "@/app/(app)/appointments/[id]/AppointmentDetailPanel";
import {toPlain} from "@/lib/toPlain";

/** `.lean().then(toPlain)` still carries `_id` as a mongoose ObjectId (with its own `toJSON`) even though none
 * of these doc types declare that field - passing it straight into a "use client" component's
 * props trips React/Next's server-to-client boundary warning ("Objects with toJSON methods are
 * not supported"), the same gap `clients/[id]/page.tsx` already found and works around. Nothing
 * in this app reads `_id` (the app's own UUID fields are the real identifiers), so it is dropped
 * here for every doc this page passes to its client component. */
function omitMongoId<T>(doc: T & {_id?: unknown}): T {
  const {_id, ...rest} = doc;
  void _id;
  return rest as T;
}

export default async function AppointmentDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  await connectToDatabase();
  const appointment = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>().then(toPlain);
  if (!appointment) notFound();

  const petIds = appointment.petIds ?? [];
  const [client, fetchedPets, service, bookingSettings, practitioners] = await Promise.all([
    appointment.clientId ? Client.findOne({clientId: appointment.clientId}).lean<ClientDoc>().then(toPlain) : Promise.resolve(null),
    petIds.length > 0 ? Pet.find({petId: {$in: petIds}}).lean<PetDoc[]>().then(toPlain) : Promise.resolve([]),
    appointment.serviceId ? Service.findOne({serviceId: appointment.serviceId}).lean<ServiceDoc>().then(toPlain) : Promise.resolve(null),
    getBookingSettings(),
    listBookablePractitioners(),
  ]);
  // `Pet.find({$in: ...})` does not preserve petIds' order - restore it so this page's pet order
  // matches the stored petName's order everywhere it's shown (see orderPetsByPetIds's doc comment).
  const pets = orderPetsByPetIds(fetchedPets, petIds);

  return (
    <>
      <PageHeader title="Appointment" description={`${appointment.clientName} - ${appointment.petName}`} />
      <AppointmentDetailPanel
        appointment={omitMongoId(appointment)}
        client={client ? omitMongoId(client) : null}
        pets={pets.map((pet) => omitMongoId(pet))}
        serviceName={service?.name}
        timeZone={bookingSettings.timezone}
        schedulingMode={bookingSettings.schedulingMode ?? "clinic"}
        practitioners={practitioners}
      />
    </>
  );
}
