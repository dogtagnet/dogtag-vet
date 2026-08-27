"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";

export function PaymentActions({paymentId, status, viewUrl}: {paymentId: string; status: string; viewUrl: string}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function markPaid() {
    if (!note.trim()) {
      snackbar.show("A note is required to mark this paid manually", "danger");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/payments/${paymentId}/mark-paid`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({note: note.trim()}),
      });
      if (!res.ok) throw new Error();
      snackbar.show("Payment marked paid", "ok");
      router.refresh();
    } catch {
      snackbar.show("Could not mark this payment paid", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch(`/api/payments/${paymentId}/cancel`, {method: "POST"});
      if (!res.ok) throw new Error();
      snackbar.show("Payment cancelled", "ok");
      router.refresh();
    } catch {
      snackbar.show("Could not cancel this payment", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    if (!email.trim()) {
      snackbar.show("Enter an email address", "danger");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/payments/${paymentId}/email`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: email.trim()}),
      });
      if (!res.ok) throw new Error();
      snackbar.show(`Invoice emailed to ${email.trim()}`, "ok");
      setEmail("");
      router.refresh();
    } catch {
      snackbar.show("Could not send that email", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(viewUrl);
      snackbar.show("Public link copied", "ok");
    } catch {
      snackbar.show("Could not copy - copy it manually", "danger");
    }
  }

  return (
    <div className="space-y-4 rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="text-section-title text-ink">Actions</h3>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={copyLink} type="button">
          Copy public link
        </Button>
        <a href={`/pay/${paymentId}/invoice`} target="_blank" rel="noreferrer">
          <Button variant="secondary" type="button">
            Download invoice
          </Button>
        </a>
      </div>

      {status === "pending" && (
        <>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="mark-paid-note" className="mb-1.5 block text-body font-medium text-ink">
                Mark paid manually
              </label>
              <Input id="mark-paid-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Paid by check #204" />
            </div>
            <Button onClick={markPaid} disabled={busy} type="button">
              Mark paid
            </Button>
          </div>
          <Button variant="danger" onClick={cancel} disabled={busy} type="button">
            Cancel payment
          </Button>
        </>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="email-invoice" className="mb-1.5 block text-body font-medium text-ink">
            Email invoice to
          </label>
          <Input id="email-invoice" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" />
        </div>
        <Button variant="secondary" onClick={sendEmail} disabled={busy} type="button">
          Send
        </Button>
      </div>
    </div>
  );
}
