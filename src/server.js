const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');

const store = new Store(path.join(process.cwd(), 'data.json'));
const PORT = process.env.PORT || 3000;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType = 'text/plain') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2e6) {
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid json'));
      }
    });
  });
}

function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return store.getUserByToken(token);
}

function simplePdf(title, rows) {
  const lines = [title, '', ...rows.map((r) => JSON.stringify(r))];
  const escaped = lines.map((l) => String(l).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  let y = 760;
  const textOps = escaped.map((line) => {
    const op = `BT /F1 10 Tf 36 ${y} Td (${line.slice(0, 120)}) Tj ET`;
    y -= 14;
    return op;
  }).join('\n');

  const objects = [];
  const addObj = (body) => objects.push(body);
  addObj('<< /Type /Catalog /Pages 2 0 R >>');
  addObj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObj('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  addObj(`<< /Length ${Buffer.byteLength(textOps, 'utf8')} >>\nstream\n${textOps}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

const staticTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

async function handleApi(req, res, pathname) {
  const method = req.method;
  try {
    if (method === 'POST' && pathname === '/api/login/pin') {
      const body = await parseBody(req);
      const result = store.loginByPin(body.pin);
      if (!result) return sendJson(res, 401, { error: 'Invalid PIN' });
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && pathname === '/api/login/manager') {
      const body = await parseBody(req);
      const result = store.loginManager(body.email, body.password);
      if (!result) return sendJson(res, 401, { error: 'Invalid credentials' });
      return sendJson(res, 200, result);
    }

    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Authentication required' });

    if (method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, { user: store.getUserSafe(user) });
    }

    if (method === 'POST' && pathname === '/api/users') {
      const body = await parseBody(req);
      return sendJson(res, 201, { user: store.createUser(user, body) });
    }

    if (method === 'POST' && pathname === '/api/parts') {
      const body = await parseBody(req);
      return sendJson(res, 200, { part: store.ensurePart(body) });
    }

    if (method === 'GET' && pathname === '/api/parts/search') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const q = url.searchParams.get('q') || '';
      return sendJson(res, 200, { results: store.searchParts(q) });
    }

    if (method === 'POST' && pathname === '/api/inventory/receive') {
      const body = await parseBody(req);
      return sendJson(res, 200, store.receive(user, body));
    }

    if (method === 'POST' && pathname === '/api/inventory/checkout') {
      const body = await parseBody(req);
      return sendJson(res, 200, store.checkout(user, body));
    }

    if (method === 'POST' && pathname === '/api/inventory/transfer') {
      const body = await parseBody(req);
      return sendJson(res, 200, store.transfer(user, body));
    }

    if (method === 'POST' && pathname === '/api/inventory/count') {
      const body = await parseBody(req);
      return sendJson(res, 200, store.count(user, body));
    }

    if (method === 'POST' && pathname === '/api/po') {
      const body = await parseBody(req);
      return sendJson(res, 201, store.createPurchaseOrder(user, body));
    }

    if (method === 'POST' && pathname === '/api/po/receive') {
      const body = await parseBody(req);
      return sendJson(res, 200, store.receiveAgainstPo(user, body));
    }

    if (method === 'GET' && pathname.startsWith('/api/reports/')) {
      const type = pathname.replace('/api/reports/', '');
      return sendJson(res, 200, { rows: store.getReport(type) });
    }

    if (method === 'GET' && pathname === '/api/alerts/low-stock') {
      return sendJson(res, 200, { alerts: store.lowStockAlerts() });
    }

    if (method === 'GET' && pathname.startsWith('/api/export/')) {
      const type = pathname.replace('/api/export/', '').replace('.pdf', '');
      const rows = store.getReport(type);
      const pdf = simplePdf(`${type} report`, rows);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${type}-report.pdf"`
      });
      res.end(pdf);
      return;
    }

    sendJson(res, 404, { error: 'API route not found' });
  } catch (error) {
    const status = error.status || 400;
    sendJson(res, status, { error: error.message || 'Request failed' });
  }
}

function handleStatic(req, res, pathname) {
  const publicDir = path.join(process.cwd(), 'public');
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(publicDir, safePath);
  if (!fullPath.startsWith(publicDir)) {
    return sendText(res, 403, 'Forbidden');
  }
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return sendText(res, 404, 'Not found');
  }
  const ext = path.extname(fullPath);
  const contentType = staticTypes[ext] || 'application/octet-stream';
  sendText(res, 200, fs.readFileSync(fullPath), contentType);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  handleStatic(req, res, pathname);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Arksen stock desktop app server running on http://localhost:${PORT}`);
  });
}

module.exports = { server, store, simplePdf };
