# Ticket BIL-2214 (support queue)

Customer `cust_0042` (Dana Whitfield) was refunded twice for order ORD-7731. The ledger
shows two refund entries of $129.00, both referencing REF-5510, two minutes apart — the
second one is a double-submit from the old refund form. Stripe shows a single refund of
$129.00 actually sent to her card.

Remove the duplicate refund entry so her ledger matches what actually happened, then
close the ticket.
