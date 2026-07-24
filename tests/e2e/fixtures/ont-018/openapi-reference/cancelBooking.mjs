/**
 * Orangerail action `cancelBooking` (from OpenAPI POST /bookings/{uid}/cancel).
 * Summary: Cancel a booking
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; wire up `execute` to enable it.
 */
import { z } from 'zod';
import { notImplemented } from 'orangerail-core';

import { registry } from './_registry.mjs';

export const cancelBooking = registry.defineAction({
  name: "cancelBooking",
  input: z.object({
    "uid": z.string(),
    "cancellationReason": z.string(),
    "allRemainingBookings": z.boolean().optional(),
  }),
  policy: { approval: 'required' },
  execute: notImplemented,
});
