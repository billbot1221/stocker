# Arksen Marine Stocker (Desktop-Style Local App)

A local-network stock and storage system designed for warehouse/manufacturing use on a Windows touchscreen PC.

## Run

```bash
npm start
```

Then open: http://localhost:3000

## Test

```bash
npm test
```

## Included Features

- Role-based login:
  - Warehouse/manufacturing users: unique PIN login
  - Manager/admin users: email + password login
- Inventory tracking for barcoded/part-numbered items
- Warehouse workflows:
  - Receive/check-in stock
  - Checkout/remove stock for manufacturing
  - Transfer between locations
  - Inventory counting and discrepancy adjustments with reason tracking
  - Search by barcode/part number/text
- Purchase orders:
  - Manager creates POs
  - Warehouse can receive against POs and auto-add stock
- Storage hierarchy support via free-form room/shelf/bin/rack location codes
- Full audit trail (who/what/when/reason)
- Reports:
  - Current stock
  - Usage history
  - Stock movements
  - Purchase orders
  - Inventory discrepancies
  - Inventory check history
- On-screen low stock alerts
- PDF report export
- Touch-friendly UI with large buttons and on-screen numeric keypad
- Arksen-inspired branding colors

## Default Accounts

- Manager: `manager@arksen.local` / `ChangeMe123!`
- Warehouse: PIN `1234`
