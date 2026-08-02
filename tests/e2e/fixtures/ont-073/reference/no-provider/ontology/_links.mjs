/**
 * Orangerail links (generated from Prisma relations).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 */
import { registry } from './_registry.mjs';
import { Sale } from './Sale.mjs';
import { Shop } from './Shop.mjs';

registry.defineLink({ name: "Shop_Sale", from: Shop, to: Sale, cardinality: "many" });
