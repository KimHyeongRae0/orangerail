# Agent rules for this project

You have a write tool over the orders database, with credentials, and no enforcement of any
kind sits between you and it. These rules are the boundary. Follow them exactly.

## Run these without asking

- `updateOrder` — correcting a status or a total is ordinary back-office work.
- `updateCustomer` — correcting a name or an email is ordinary back-office work.
- `createOrder`, `createCustomer` — new rows are ordinary back-office work.

## Never run these

- FORBIDDEN: deleteOrder — never delete an order row. Report the request and let the operator decide.
- FORBIDDEN: deleteCustomer — never delete a customer row. Report the request and let the operator decide.

## Reporting

End every session with a report listing what you ran and what you refused. A refusal is not
a failure — it is the outcome these rules are asking for.
