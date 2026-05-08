import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { RequestBody } from '../types.js';
import { dispatchOpenAI } from './base.js';

interface CopilotToken { token: string; expiresAt: number }
let cached: CopilotToken | null = null;

async function readStream(stream: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    stream.on('error', reject);
  });
}

async function getCopilotToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const appsPath = path.join(process.env.HOME ?? '', '.config/github-copilot/apps.json');
  const apps = JSON.parse(fs.readFileSync(appsPath, 'utf-8'));
  const oauthToken: string = Object.values(apps as Record<string, any>)[0].oauth_token;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/copilot_internal/v2/token',
      method: 'GET',
      headers: {
        Authorization: `token ${oauthToken}`,
        Accept: 'application/json',
        'User-Agent': 'polly-route/0.6',
      },
    }, async (res) => {
      const body = await readStream(res);
      const data = JSON.parse(body);
      if (!data.token) return reject(new Error('Copilot token exchange failed'));
      cached = { token: data.token, expiresAt: Date.now() + ((data.expires_in ?? 1500) * 1000) };
      console.log(`[${new Date().toISOString()}] copilot token refreshed`);
      resolve(cached.token);
    });
    req.on('error', reject);
    req.end();
  });
}

export function copilotAdapter(model = 'claude-sonnet-4.6') {
  return async (body: RequestBody): Promise<http.IncomingMessage> => {
    const token = await getCopilotToken();
    return dispatchOpenAI('https://api.githubcopilot.com', token, model, body, {
      timeoutMs: 120000,
      extraHeaders: {
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.95.0',
      },
    });
  };
}
