let appHandler;

async function getApp() {
  if (!appHandler) {
    const mod = await import('../server/server.js');
    appHandler = mod.app;
  }
  return appHandler;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
