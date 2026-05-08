import http from 'http';
import { RequestBody } from '../types.js';
import { OllamaModel } from '../config.js';
import { dispatchOpenAI } from './base.js';
import { estimateChars } from '../injector.js';

export class OllamaAdapter {
  constructor(
    private models: OllamaModel[],
    private baseUrl: string
  ) {}

  pickModel(requestChars: number, minWeight?: OllamaModel['weight']): OllamaModel | null {
    const needed = Math.ceil(requestChars * 1.2);
    const order: OllamaModel['weight'][] = ['light', 'medium', 'heavy'];
    const minIdx = minWeight ? order.indexOf(minWeight) : 0;
    return this.models.find(m =>
      m.maxChars >= needed && order.indexOf(m.weight) >= minIdx
    ) ?? null;
  }

  async dispatch(model: OllamaModel, body: RequestBody): Promise<http.IncomingMessage> {
    return dispatchOpenAI(
      `${this.baseUrl}/v1`,
      'ollama',
      model.id,
      body,
      { timeoutMs: 120000 }
    );
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/api/tags`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
  }
}
