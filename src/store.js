const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB = {
  users: [],
  parts: [],
  locations: [],
  inventory: [],
  movements: [],
  purchaseOrders: [],
  sessions: []
};

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

class Store {
  constructor(dbPath) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data.json');
    this.db = this.load();
    this.bootstrap();
  }

  load() {
    if (!fs.existsSync(this.dbPath)) {
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    const raw = fs.readFileSync(this.dbPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...JSON.parse(JSON.stringify(DEFAULT_DB)), ...parsed };
  }

  save() {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
  }

  nextId(collectionName) {
    const coll = this.db[collectionName];
    const max = coll.reduce((m, item) => Math.max(m, Number(item.id || 0)), 0);
    return max + 1;
  }

  bootstrap() {
    if (this.db.users.length === 0) {
      this.db.users.push({
        id: 1,
        name: 'Default Manager',
        role: 'manager',
        email: 'manager@arksen.local',
        passwordHash: hashPassword('ChangeMe123!')
      });
      this.db.users.push({
        id: 2,
        name: 'Warehouse Operator',
        role: 'warehouse',
        pin: '1234'
      });
      this.save();
    }
  }

  getUserSafe(user) {
    if (!user) return null;
    const { passwordHash, pin, ...safe } = user;
    return safe;
  }

  createSession(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    this.db.sessions = this.db.sessions.filter((s) => s.userId !== userId);
    this.db.sessions.push({ token, userId, createdAt: nowIso() });
    this.save();
    return token;
  }

  getUserByToken(token) {
    const session = this.db.sessions.find((s) => s.token === token);
    if (!session) return null;
    return this.db.users.find((u) => u.id === session.userId) || null;
  }

  loginByPin(pin) {
    const user = this.db.users.find((u) => u.role !== 'manager' && u.pin === String(pin || '').trim());
    if (!user) return null;
    const token = this.createSession(user.id);
    return { token, user: this.getUserSafe(user) };
  }

  loginManager(email, password) {
    const key = normalizeKey(email);
    const user = this.db.users.find((u) => u.role === 'manager' && normalizeKey(u.email) === key);
    if (!user || !verifyPassword(password, user.passwordHash)) return null;
    const token = this.createSession(user.id);
    return { token, user: this.getUserSafe(user) };
  }

  requireManager(user) {
    if (!user || user.role !== 'manager') {
      const error = new Error('Manager access required');
      error.status = 403;
      throw error;
    }
  }

  createUser(actor, input) {
    this.requireManager(actor);
    const role = input.role === 'manager' ? 'manager' : 'warehouse';
    if (role === 'manager') {
      if (!input.email || !input.password) {
        throw new Error('Manager user requires email and password');
      }
    } else if (!input.pin) {
      throw new Error('Warehouse user requires PIN');
    }

    const id = this.nextId('users');
    const user = {
      id,
      name: input.name || `User ${id}`,
      role
    };

    if (role === 'manager') {
      user.email = input.email;
      user.passwordHash = hashPassword(input.password);
    } else {
      user.pin = String(input.pin).trim();
    }

    this.db.users.push(user);
    this.audit(actor, {
      action: 'user_created',
      reason: 'user_management',
      note: `Created ${role} user ${user.name}`
    });
    this.save();
    return this.getUserSafe(user);
  }

  ensurePart(input) {
    const partNumber = String(input.partNumber || '').trim();
    const barcode = String(input.barcode || '').trim();
    if (!partNumber && !barcode) {
      throw new Error('partNumber or barcode is required');
    }

    let part = this.db.parts.find((p) =>
      (partNumber && normalizeKey(p.partNumber) === normalizeKey(partNumber)) ||
      (barcode && normalizeKey(p.barcode) === normalizeKey(barcode))
    );

    if (!part) {
      part = {
        id: this.nextId('parts'),
        partNumber: partNumber || `PART-${Date.now()}`,
        barcode: barcode || '',
        description: input.description || '',
        lowStockThreshold: Number(input.lowStockThreshold || 0)
      };
      this.db.parts.push(part);
    } else {
      if (input.description !== undefined) part.description = input.description;
      if (input.lowStockThreshold !== undefined) part.lowStockThreshold = Number(input.lowStockThreshold || 0);
      if (partNumber) part.partNumber = partNumber;
      if (barcode) part.barcode = barcode;
    }
    this.save();
    return part;
  }

  ensureLocation(code) {
    const clean = String(code || '').trim();
    if (!clean) {
      throw new Error('location is required');
    }
    let location = this.db.locations.find((l) => normalizeKey(l.code) === normalizeKey(clean));
    if (!location) {
      location = { id: this.nextId('locations'), code: clean };
      this.db.locations.push(location);
      this.save();
    }
    return location;
  }

  getInventoryRecord(partId, locationId, createIfMissing = false) {
    let record = this.db.inventory.find((i) => i.partId === partId && i.locationId === locationId);
    if (!record && createIfMissing) {
      record = { partId, locationId, qty: 0 };
      this.db.inventory.push(record);
    }
    return record;
  }

  partByLookup(lookup) {
    const key = normalizeKey(lookup);
    return this.db.parts.find((p) => normalizeKey(p.partNumber) === key || normalizeKey(p.barcode) === key) || null;
  }

  audit(user, movement) {
    this.db.movements.push({
      id: this.nextId('movements'),
      timestamp: nowIso(),
      userId: user?.id || null,
      ...movement
    });
  }

  receive(actor, input) {
    const part = this.ensurePart(input);
    const location = this.ensureLocation(input.location);
    const qty = Number(input.qty || 0);
    if (qty <= 0) throw new Error('qty must be > 0');

    const record = this.getInventoryRecord(part.id, location.id, true);
    record.qty += qty;

    this.audit(actor, {
      action: 'receive',
      partId: part.id,
      qty,
      toLocationId: location.id,
      reason: input.reason || 'received_stock',
      poNumber: input.poNumber || null
    });

    this.save();
    return { part, location, qty: record.qty };
  }

  checkout(actor, input) {
    const part = this.partByLookup(input.lookup || input.partNumber || input.barcode);
    if (!part) throw new Error('part not found');
    const location = this.ensureLocation(input.location);
    const qty = Number(input.qty || 0);
    if (qty <= 0) throw new Error('qty must be > 0');

    const record = this.getInventoryRecord(part.id, location.id, true);
    if (record.qty < qty) throw new Error('insufficient quantity');
    record.qty -= qty;

    this.audit(actor, {
      action: 'checkout',
      partId: part.id,
      qty: -qty,
      fromLocationId: location.id,
      reason: input.reason || 'manufacturing_use'
    });

    this.save();
    return { part, location, qty: record.qty };
  }

  transfer(actor, input) {
    const part = this.partByLookup(input.lookup || input.partNumber || input.barcode);
    if (!part) throw new Error('part not found');
    const qty = Number(input.qty || 0);
    if (qty <= 0) throw new Error('qty must be > 0');

    const from = this.ensureLocation(input.fromLocation);
    const to = this.ensureLocation(input.toLocation);
    const fromRecord = this.getInventoryRecord(part.id, from.id, true);
    if (fromRecord.qty < qty) throw new Error('insufficient quantity');
    const toRecord = this.getInventoryRecord(part.id, to.id, true);

    fromRecord.qty -= qty;
    toRecord.qty += qty;

    this.audit(actor, {
      action: 'transfer',
      partId: part.id,
      qty,
      fromLocationId: from.id,
      toLocationId: to.id,
      reason: input.reason || 'location_transfer'
    });

    this.save();
    return { part, from, to };
  }

  count(actor, input) {
    const part = this.partByLookup(input.lookup || input.partNumber || input.barcode);
    if (!part) throw new Error('part not found');
    const location = this.ensureLocation(input.location);
    const countedQty = Number(input.countedQty || 0);
    if (countedQty < 0) throw new Error('countedQty must be >= 0');

    const record = this.getInventoryRecord(part.id, location.id, true);
    const delta = countedQty - record.qty;
    record.qty = countedQty;

    this.audit(actor, {
      action: 'count_adjustment',
      partId: part.id,
      qty: delta,
      toLocationId: location.id,
      reason: input.reason || 'correction'
    });

    this.save();
    return { part, location, countedQty, delta };
  }

  createPurchaseOrder(actor, input) {
    this.requireManager(actor);
    const number = String(input.number || `PO-${Date.now()}`);
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('items are required');
    }

    const items = input.items.map((item) => {
      const part = this.ensurePart(item);
      const qtyOrdered = Number(item.qtyOrdered || item.qty || 0);
      if (qtyOrdered <= 0) throw new Error('qtyOrdered must be > 0');
      return { partId: part.id, qtyOrdered, qtyReceived: 0 };
    });

    const po = {
      id: this.nextId('purchaseOrders'),
      number,
      status: 'open',
      createdBy: actor.id,
      createdAt: nowIso(),
      items
    };

    this.db.purchaseOrders.push(po);
    this.audit(actor, {
      action: 'po_created',
      reason: 'purchase_order',
      note: number,
      poNumber: number
    });
    this.save();
    return po;
  }

  receiveAgainstPo(actor, input) {
    const number = String(input.poNumber || '').trim();
    const po = this.db.purchaseOrders.find((p) => p.number === number);
    if (!po) throw new Error('PO not found');

    const part = this.partByLookup(input.lookup || input.partNumber || input.barcode);
    if (!part) throw new Error('part not found');

    const item = po.items.find((it) => it.partId === part.id);
    if (!item) throw new Error('part not in PO');

    const qty = Number(input.qty || 0);
    if (qty <= 0) throw new Error('qty must be > 0');

    item.qtyReceived += qty;
    if (po.items.every((it) => it.qtyReceived >= it.qtyOrdered)) {
      po.status = 'received';
    }

    this.receive(actor, {
      partNumber: part.partNumber,
      barcode: part.barcode,
      location: input.location,
      qty,
      reason: 'po_received',
      poNumber: po.number
    });

    this.save();
    return po;
  }

  searchParts(query) {
    const key = normalizeKey(query);
    return this.db.parts.filter((p) =>
      normalizeKey(p.partNumber).includes(key) ||
      normalizeKey(p.barcode).includes(key) ||
      normalizeKey(p.description).includes(key)
    );
  }

  stockReport() {
    return this.db.inventory.map((inv) => {
      const part = this.db.parts.find((p) => p.id === inv.partId) || {};
      const location = this.db.locations.find((l) => l.id === inv.locationId) || {};
      return {
        partNumber: part.partNumber,
        barcode: part.barcode,
        description: part.description,
        location: location.code,
        qty: inv.qty,
        lowStockThreshold: part.lowStockThreshold || 0
      };
    });
  }

  lowStockAlerts() {
    return this.stockReport().filter((row) => Number(row.qty) <= Number(row.lowStockThreshold || 0));
  }

  movementReport() {
    return this.db.movements.map((m) => {
      const part = this.db.parts.find((p) => p.id === m.partId) || {};
      const user = this.db.users.find((u) => u.id === m.userId) || {};
      const from = this.db.locations.find((l) => l.id === m.fromLocationId) || {};
      const to = this.db.locations.find((l) => l.id === m.toLocationId) || {};
      return {
        timestamp: m.timestamp,
        action: m.action,
        user: user.name || 'system',
        partNumber: part.partNumber || '',
        qty: m.qty,
        from: from.code || '',
        to: to.code || '',
        reason: m.reason || '',
        poNumber: m.poNumber || ''
      };
    });
  }

  discrepancyReport() {
    return this.movementReport().filter((m) => ['damage', 'loss', 'correction', 'took_out_too_much'].includes(m.reason));
  }

  poReport() {
    return this.db.purchaseOrders.map((po) => ({
      number: po.number,
      status: po.status,
      createdAt: po.createdAt,
      itemCount: po.items.length,
      totalOrdered: po.items.reduce((sum, it) => sum + it.qtyOrdered, 0),
      totalReceived: po.items.reduce((sum, it) => sum + it.qtyReceived, 0)
    }));
  }

  inventoryChecksReport() {
    return this.movementReport().filter((m) => m.action === 'count_adjustment');
  }

  getReport(type) {
    switch (type) {
      case 'stock': return this.stockReport();
      case 'usage': return this.movementReport().filter((m) => m.action === 'checkout');
      case 'movements': return this.movementReport();
      case 'purchase-orders': return this.poReport();
      case 'discrepancies': return this.discrepancyReport();
      case 'inventory-checks': return this.inventoryChecksReport();
      default: throw new Error('Unknown report type');
    }
  }
}

module.exports = {
  Store,
  hashPassword,
  verifyPassword
};
