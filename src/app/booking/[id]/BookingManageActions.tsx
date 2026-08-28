"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";
import {Button} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {AppointmentStatus} from "@/lib/models/Appointment";

/** Cancel button for `/booking/{id}` - calls the same public, token-gated
 * `POST /v1/booking/appointments/{id}/cancel` a script or another client would (`vet-public-api.yaml`),
 * never a staff-only route, since this page carries no staff session. */
export function BookingManageActions({
  appointmentId,
  token,
  cancellable,
  status,
}: {
  appointmentId: string;
  token: string;
  cancellable: boolean;
  status: AppointmentStatus;
}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const [busy, setBusy] = useState(false);

  if (status === "cancelled" || status === "no_show") {
    return <p className="text-body text-ink-muted">This appointment is cancelled.</p>;
  }

  if (!cancellable) {
    return <p className="text-body text-ink-muted">This appointment can no longer be cancelled online.</p>;
  }

  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch(`/v1/booking/appointments/${appointmentId}/cancel?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not cancel this appointment.");
      snackbar.show("Appointment cancelled", "ok");
      router.refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Could not cancel this appointment.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="danger" onClick={cancel} disabled={busy}>
      Cancel appointment
    </Button>
  );
}
