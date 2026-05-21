let token = null;
let currentUser = null;

const loginEl = document.getElementById('login');
const appEl = document.getElementById('app');
const userLabel = document.getElementById('user-label');
const output = document.getElementById('output');

const pinForm = document.getElementById('pin-form');
const managerForm = document.getElementById('manager-form');
const pinTab = document.getElementById('pin-tab');
const managerTab = document.getElementById('manager-tab');

const activeInput = { el: null };
document.querySelectorAll('input').forEach((el) => {
  el.addEventListener('focus', () => { activeInput.el = el; });
});

function show(data) {
  output.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(payload.error || payload || 'request failed');
  return payload;
}

function toggleManagerActions() {
  document.querySelectorAll('.manager-only').forEach((el) => {
    el.classList.toggle('hidden', currentUser?.role !== 'manager');
  });
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function askCommonBase(includeLocation = true) {
  const lookup = window.prompt('Scan barcode or enter part number');
  if (!lookup) return null;
  const qty = toNum(window.prompt('Quantity'), 0);
  if (qty <= 0) {
    alert('Quantity must be > 0');
    return null;
  }
  const base = { lookup, qty };
  if (includeLocation) {
    const location = window.prompt('Location (room/shelf/bin/rack format)');
    if (!location) return null;
    base.location = location;
  }
  return base;
}

pinTab.onclick = () => {
  pinForm.classList.remove('hidden');
  managerForm.classList.add('hidden');
};
managerTab.onclick = () => {
  managerForm.classList.remove('hidden');
  pinForm.classList.add('hidden');
};

pinForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const { token: t, user } = await api('/api/login/pin', 'POST', { pin: document.getElementById('pin').value });
    token = t;
    currentUser = user;
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    userLabel.textContent = `${user.name} (${user.role})`;
    toggleManagerActions();
    show('Logged in. Use large action buttons to process stock.');
  } catch (err) { alert(err.message); }
};

managerForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const { token: t, user } = await api('/api/login/manager', 'POST', {
      email: document.getElementById('email').value,
      password: document.getElementById('password').value
    });
    token = t;
    currentUser = user;
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    userLabel.textContent = `${user.name} (${user.role})`;
    toggleManagerActions();
    show('Manager mode enabled.');
  } catch (err) { alert(err.message); }
};

const actions = {
  async receive() {
    const base = askCommonBase(true);
    if (!base) return;
    const reason = window.prompt('Reason', 'received_stock') || 'received_stock';
    const data = await api('/api/inventory/receive', 'POST', {
      partNumber: base.lookup,
      barcode: base.lookup,
      location: base.location,
      qty: base.qty,
      reason
    });
    show(data);
  },
  async checkout() {
    const base = askCommonBase(true);
    if (!base) return;
    const reason = window.prompt('Reason (manufacturing_use, took_out_too_much, damage, loss)', 'manufacturing_use') || 'manufacturing_use';
    show(await api('/api/inventory/checkout', 'POST', { ...base, reason }));
  },
  async transfer() {
    const lookup = window.prompt('Scan barcode or enter part number');
    if (!lookup) return;
    const qty = toNum(window.prompt('Quantity to move'), 0);
    const fromLocation = window.prompt('From location');
    const toLocation = window.prompt('To location');
    if (!qty || !fromLocation || !toLocation) return;
    show(await api('/api/inventory/transfer', 'POST', { lookup, qty, fromLocation, toLocation }));
  },
  async count() {
    const lookup = window.prompt('Scan barcode or enter part number');
    if (!lookup) return;
    const location = window.prompt('Location counted');
    const countedQty = toNum(window.prompt('Counted quantity'), 0);
    const reason = window.prompt('Reason (correction, damage, loss, took_out_too_much)', 'correction') || 'correction';
    show(await api('/api/inventory/count', 'POST', { lookup, location, countedQty, reason }));
  },
  async search() {
    const q = window.prompt('Search part by barcode/part number/text') || '';
    show(await api(`/api/parts/search?q=${encodeURIComponent(q)}`));
  },
  async po() {
    if (currentUser.role !== 'manager') return alert('Manager only');
    const number = window.prompt('PO Number', `PO-${Date.now()}`);
    const lookup = window.prompt('Part number or barcode');
    const qtyOrdered = toNum(window.prompt('Qty ordered'), 0);
    if (!number || !lookup || !qtyOrdered) return;
    show(await api('/api/po', 'POST', { number, items: [{ partNumber: lookup, barcode: lookup, qtyOrdered }] }));
  },
  async 'receive-po'() {
    const poNumber = window.prompt('PO Number');
    const lookup = window.prompt('Part number or barcode');
    const qty = toNum(window.prompt('Qty received'), 0);
    const location = window.prompt('Receive location');
    if (!poNumber || !lookup || !qty || !location) return;
    show(await api('/api/po/receive', 'POST', { poNumber, lookup, qty, location }));
  },
  async report() {
    const type = window.prompt('Report type: stock, usage, movements, purchase-orders, discrepancies, inventory-checks', 'stock') || 'stock';
    const report = await api(`/api/reports/${encodeURIComponent(type)}`);
    const exportPdf = window.confirm('Export this report to PDF now?');
    if (exportPdf) {
      window.open(`/api/export/${encodeURIComponent(type)}.pdf`, '_blank');
    }
    show(report);
  },
  async user() {
    if (currentUser.role !== 'manager') return alert('Manager only');
    const role = window.prompt('New user role (warehouse or manager)', 'warehouse') || 'warehouse';
    const name = window.prompt('Name');
    if (!name) return;
    if (role === 'manager') {
      const email = window.prompt('Email');
      const password = window.prompt('Password');
      show(await api('/api/users', 'POST', { role, name, email, password }));
      return;
    }
    const pin = window.prompt('PIN');
    show(await api('/api/users', 'POST', { role, name, pin }));
  }
};

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await actions[btn.dataset.action]();
    } catch (err) {
      alert(err.message);
    }
  });
});

document.getElementById('refresh-alerts').onclick = async () => {
  try {
    const result = await api('/api/alerts/low-stock');
    if (result.alerts.length) {
      alert(`Low stock alerts:\n${result.alerts.map((a) => `${a.partNumber} @ ${a.location}: ${a.qty}`).join('\n')}`);
    } else {
      alert('No low stock alerts.');
    }
    show(result);
  } catch (err) {
    alert(err.message);
  }
};

const keypad = document.getElementById('keypad');
[...'1234567890⌫'].forEach((digit) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = digit;
  btn.className = 'big';
  btn.onclick = () => {
    if (!activeInput.el) return;
    if (digit === '⌫') {
      activeInput.el.value = activeInput.el.value.slice(0, -1);
    } else {
      activeInput.el.value += digit;
    }
  };
  keypad.appendChild(btn);
});
