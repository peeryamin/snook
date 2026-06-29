// Tiny static file server for the Black Racks PWA frontend.
// Serves /app/web on port 3000. All /api/* calls from the browser go through
// the Kubernetes ingress to port 8001 (the FastAPI -> Node bridge), so we
// don't need to proxy here.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  if (/\.(html|js|css|webmanifest)$/i.test(req.path) || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(WEB_DIR, { extensions: ['html'] }));

// SPA-ish fallback: send login page for unknown non-asset routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API routes are handled by the backend service' });
  }
  res.sendFile(path.join(WEB_DIR, 'login.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Black Racks static frontend running on http://${HOST}:${PORT}`);
  console.log(`Serving: ${WEB_DIR}`);
});
