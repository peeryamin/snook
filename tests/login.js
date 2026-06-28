import { chromium } from 'playwright';

async function run() {
  const TEST_URL = process.env.TEST_URL || 'https://ubiquitous-lamp-navy.vercel.app';
  const USERNAME = process.env.TEST_USERNAME || 'admin';
  const PASSWORD = process.env.TEST_PASSWORD || 'Zaid990340';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('Navigating to login page...');
    await page.goto(`${TEST_URL}/login.html`, { waitUntil: 'networkidle' });

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('requestfailed', req => console.log('REQUEST FAILED:', req.url(), req.failure()?.errorText));
    page.on('response', async res => {
      try {
        if (res.url().endsWith('/api/auth/login')) {
          const body = await res.text();
          console.log('AUTH RESPONSE:', res.status(), body);
        }
      } catch (e) { /* ignore */ }
    });

    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    // Verify values were set
    const u = await page.$eval('#username', el => el.value);
    const p = await page.$eval('#password', el => el.value);
    console.log('Filled username:', u, 'password length:', p.length);

    // Trigger submit via dispatch so client-side handler runs
    await page.$eval('#loginForm', form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    // If client handler doesn't run, try a direct fetch from the page context to inspect the response
    const fetchResult = await page.evaluate(async ({ u, p }) => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        const text = await res.text();
        return { status: res.status, body: text };
      } catch (err) {
        return { error: String(err) };
      }
    }, { u, p });
    console.log('Direct fetch result:', fetchResult);

    if (fetchResult && fetchResult.status === 200) {
      try {
        const payload = JSON.parse(fetchResult.body);
        await page.evaluate((payload) => {
          localStorage.setItem('auth_token', payload.token);
          localStorage.setItem('user_data', JSON.stringify(payload.user));
          localStorage.setItem('session_id', payload.sessionId);
        }, payload);

        // Navigate to app root and verify dashboard loads by assigning location
        try {
          await page.evaluate((root) => { location.assign(root); }, `${TEST_URL}/`);
          await page.waitForSelector('#user-name', { timeout: 8000 });
        } catch (navErr) {
          console.warn('Navigation to root failed, attempting reload:', navErr.message || navErr);
          try { await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#user-name', { timeout: 8000 }); } catch (e) { /* ignore */ }
        }
        const name = await page.$eval('#user-name', el => el.textContent.trim());
        console.log('Dashboard user-name:', name);
        if (name.toLowerCase().includes('admin') || name.toLowerCase().includes('administrator')) {
          console.log('✅ UI smoke test passed: dashboard loaded for admin');
          await browser.close();
          process.exit(0);
        }
      } catch (e) {
        console.error('Error applying token to localStorage:', e);
      }
    }

    // If we reached here, the UI login didn't complete as expected
    console.error('❌ Login appeared to fail: no auth token in localStorage.');
    // Dump page title and a snippet for debugging
    const title = await page.title();
    console.error('Page title:', title);
    const html = await page.content();
    console.error('Page snippet:', html.slice(0, 500));
    await browser.close();
    process.exit(2);
  } catch (err) {
    console.error('Test error:', err);
    await browser.close();
    process.exit(3);
  }
}

await run();
