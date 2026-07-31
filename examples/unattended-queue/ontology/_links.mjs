/**
 * Orangerail links (generated from Prisma relations).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 */
import { registry } from './_registry.mjs';
import { Customer } from './Customer.mjs';
import { Order } from './Order.mjs';
import { OrderItem } from './OrderItem.mjs';
import { Product } from './Product.mjs';

registry.defineLink({ name: "Customer_orders", from: Customer, to: Order, cardinality: "many" });
registry.defineLink({ name: "Order_items", from: Order, to: OrderItem, cardinality: "many" });
registry.defineLink({ name: "Product_items", from: Product, to: OrderItem, cardinality: "many" });
