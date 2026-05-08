import { RequestLogEntry } from './types.js';

const MAX_ENTRIES = 200;
const ring: RequestLogEntry[] = [];

export let totalRequests  = 0;
export let totalCostUsd   = 0;
export let copilotCalls   = 0;

export function record(entry: RequestLogEntry): void {
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.shift();
  totalRequests++;
  if (entry.costUsd) totalCostUsd += entry.costUsd;
  if (entry.provider.startsWith('copilot')) copilotCalls++;
}

export function recent(limit = 50): RequestLogEntry[] {
  return ring.slice(-Math.min(limit, MAX_ENTRIES)).reverse();
}

export function stats() {
  return { totalRequests, totalCostUsd, copilotCalls };
}
