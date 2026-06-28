let appHandler;

async function getApp() {
  if (!appHandler) {
    const mod = await import('../server/server.js');
    appHandler = mod.app;
  }
  return appHandler;
}

module.exports = async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
};

module.exports.default = module.exports;
