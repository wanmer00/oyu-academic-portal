// ============================================================
// Academic Portal — Frontend Static Server
// Раздаёт статику из /public. API живёт отдельно (backend).
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

// Минимальные security-заголовки (полноценные — на уровне API)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Рантайм-конфиг: адрес API берётся из env AP_API_BASE (пусто = тот же origin / localhost:3001 в dev)
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-store');
  res.send('window.AP_API_BASE = ' + JSON.stringify(process.env.AP_API_BASE || '') + ';\n');
});

// Статика
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true,
  index: false,
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
}));

// Корень → login
app.get('/', (_req, res) => res.redirect('/login.html'));

// Любой неизвестный роут → login (для случаев прямого открытия /grades и т.п.)
app.get('*', (req, res) => {
  // Запрос файла (есть расширение) без совпадения — честный 404, а не HTML под видом .js/.css/.json
  if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   Academic Portal Frontend                            ║
  ║   Port: ${PORT}                                      ║
  ╠══════════════════════════════════════════════════╣
  ║   🎓  Login:      http://localhost:${PORT}/login.html
  ║   📚  Portal:     http://localhost:${PORT}/portal.html
  ║   ⚙️   Admin:      http://localhost:${PORT}/admin-dashboard.html
  ║   🛡   Security:   http://localhost:${PORT}/security.html
  ╚══════════════════════════════════════════════════╝
  `);
});
