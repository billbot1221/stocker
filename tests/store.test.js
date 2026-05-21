const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Store } = require('../src/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stocker-test-'));
  return new Store(path.join(dir, 'data.json'));
}

test('manager and pin login work', () => {
  const store = tempStore();
  const byPin = store.loginByPin('1234');
  assert.ok(byPin?.token);
  assert.equal(byPin.user.role, 'warehouse');

  const byManager = store.loginManager('manager@arksen.local', 'ChangeMe123!');
  assert.ok(byManager?.token);
  assert.equal(byManager.user.role, 'manager');
});

test('receive, transfer, checkout and count are audited and update stock', () => {
  const store = tempStore();
  const user = store.loginByPin('1234').user;

  store.receive(user, { partNumber: 'P-1', barcode: 'B-1', location: 'A/1/1', qty: 10 });
  store.transfer(user, { lookup: 'P-1', qty: 3, fromLocation: 'A/1/1', toLocation: 'A/1/2' });
  store.checkout(user, { lookup: 'P-1', qty: 2, location: 'A/1/2', reason: 'manufacturing_use' });
  const counted = store.count(user, { lookup: 'P-1', location: 'A/1/2', countedQty: 0, reason: 'took_out_too_much' });

  assert.equal(counted.delta, -1);
  const stock = store.stockReport();
  const loc1 = stock.find((x) => x.location === 'A/1/1');
  const loc2 = stock.find((x) => x.location === 'A/1/2');
  assert.equal(loc1.qty, 7);
  assert.equal(loc2.qty, 0);
  assert.ok(store.movementReport().length >= 4);
});

test('manager can create PO and warehouse can receive against it', () => {
  const store = tempStore();
  const manager = store.loginManager('manager@arksen.local', 'ChangeMe123!').user;
  const warehouse = store.loginByPin('1234').user;

  const po = store.createPurchaseOrder(manager, {
    number: 'PO-100',
    items: [{ partNumber: 'P-PO', barcode: 'B-PO', qtyOrdered: 4 }]
  });
  assert.equal(po.number, 'PO-100');

  store.receiveAgainstPo(warehouse, { poNumber: 'PO-100', lookup: 'P-PO', qty: 4, location: 'R/1/B1' });
  const poReport = store.poReport()[0];
  assert.equal(poReport.status, 'received');

  const stock = store.stockReport().find((x) => x.partNumber === 'P-PO');
  assert.equal(stock.qty, 4);
});
