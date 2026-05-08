interface CostRate { input: number; output: number; quota?: boolean }

const COST_TABLE: Record<string, CostRate> = {
  'groq':        { input: 0.59,  output: 0.79 },
  'cerebras':    { input: 0.60,  output: 0.60 },
  'google':      { input: 0,     output: 0    },
  'mistral':     { input: 0,     output: 0    },
  'ollama':      { input: 0,     output: 0    },
  'copilot':     { input: 3.00,  output: 15.00, quota: true },
  'openrouter':  { input: 0,     output: 0    },
};

export function estimateCost(provider: string, usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  if (!usage) return null;
  const key = Object.keys(COST_TABLE).find(k => provider.startsWith(k));
  if (!key) return null;
  const r = COST_TABLE[key];
  const inputCost  = ((usage.prompt_tokens     ?? 0) / 1e6) * r.input;
  const outputCost = ((usage.completion_tokens ?? 0) / 1e6) * r.output;
  return { inputCost, outputCost, total: inputCost + outputCost, quota: !!r.quota };
}
