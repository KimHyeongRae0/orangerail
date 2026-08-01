/**
 * Orangerail links (generated from Prisma relations).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 */
import { registry } from './_registry.mjs';
import { Customer } from './Customer.mjs';
import { Payment } from './Payment.mjs';

registry.defineLink({ name: "Customer_Payment", from: Customer, to: Payment, cardinality: "many" });
