import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import http from 'http';

/**
 * Dashboard asset tests.
 *
 * The /dashboard endpoint in src/server.ts resolves dashboard.html from
 * __dirname/../dashboard.html, which works for both the src/ tree (ts-node dev)
 * and the dist/ tree (compiled production build).
 */
describe('dashboard asset', () => {
  const dashboardPath = path.join(__dirname, '..', 'dashboard.html');

  test('dashboard.html exists next to the project root', () => {
    expect(fs.existsSync(dashboardPath)).toBe(true);
  });

  test('dashboard.html contains the expected title and Chart.js CDN', () => {
    const html = fs.readFileSync(dashboardPath, 'utf-8');
    expect(html).toContain('Polly Router — Metrics Dashboard');
    expect(html).toContain('chart.js');
    expect(html).toContain('/metrics');
    expect(html).toContain('id="charts"');
  });

  test('/dashboard endpoint serves HTML when server is running', async () => {
    // Skip gracefully if the production polly-router is not running.
    const reachable = await new Promise<boolean>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port: 4200, path: '/status', method: 'GET', timeout: 800 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });

    if (!reachable) {
      console.log('polly-router not running on 127.0.0.1:4200; skipping live /dashboard check');
      return;
    }

    const html = await new Promise<{ body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: 4200, path: '/dashboard', method: 'GET', timeout: 2000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ body, headers: res.headers }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('Polly Router Metrics');
    expect(html.body).toContain('chart.js');
  }, 10000);
});
