"use client";

import {useEffect, useRef} from "react";
import {useRouter} from "next/navigation";

/**
 * Polls `GET /v1/payments/{id}/public` (the wire-spec status endpoint) every few seconds and
 * triggers a server-component re-render the moment the status this page was rendered with goes
 * stale - wp4-vet.md's "update UI live (poll or SWR refresh)". Renders nothing itself; the actual
 * paid/pending/crypto-rail UI is the server component around it, which `router.refresh()` re-runs
 * against the database.
 */
export function LivePaymentStatus({paymentId, token, initialStatus}: {paymentId: string; token: string; initialStatus: string}) {
  const router = useRouter();
  const lastStatus = useRef(initialStatus);

  useEffect(() => {
    if (lastStatus.current !== "pending") return; // paid/cancelled/expired are terminal - stop polling

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/v1/payments/${paymentId}/public?token=${encodeURIComponent(token)}`);
        if (!res.ok) return;
        const body = (await res.json()) as {status: string};
        if (body.status !== lastStatus.current) {
          lastStatus.current = body.status;
          router.refresh();
          // A status change out of "pending" is terminal (paid/cancelled/expired never revert) -
          // stop polling immediately rather than continuing to hit the endpoint every 5s forever.
          // The outer `if` above only runs once at effect setup, so without this the interval
          // would keep firing indefinitely on an already-paid invoice left open in a tab.
          if (body.status !== "pending") clearInterval(interval);
        }
      } catch {
        // best-effort polling - a transient network failure just tries again next tick
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [paymentId, token, router]);

  return null;
}
