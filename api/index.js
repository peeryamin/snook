let appHandler;
let migrated = false;

async function ensureMigrations() {
  if (migrated) return;
  const dbMod = await import('../server/db.js');
  if (dbMod && typeof dbMod.migrate === 'function') {
    await dbMod.migrate();
  }
  migrated = true;
}

async function getApp() {
  if (!appHandler) {
    const mod = await import('../server/server.js');
    appHandler = mod.app;
  }
  return appHandler;
}

export default async function handler(req, res) {
  try {
    await ensureMigrations();
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error('❌ Handler error:', err);
    res.statusCode = 500;
    res.end('Internal server error');
  }
}
