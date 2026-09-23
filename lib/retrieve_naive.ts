import type { Policy } from './engine';

const EMBED_URL = 'https://openrouter.ai/api/v1/embeddings';
const EMBED_MODEL = 'openai/text-embedding-3-small';

let cardVecCache: { key: string; vecs: number[][] } | null = null;

async function embed(texts: string[], apiKey: string): Promise<number[][]> {
  const response = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`embeddings ${response.status}`);
  const payload: any = await response.json();
  return payload.data.map((item: any) => item.embedding as number[]);
}

const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const norm = (a: number[]) => Math.sqrt(dot(a, a));
const cosine = (a: number[], b: number[]) => dot(a, b) / (norm(a) * norm(b));

export const cardText = (policy: Policy) => `${policy.title}. ${policy.rule}`;

export function claimTextFromClaim(claim: Record<string, any>): string {
  return [
    claim.category,
    claim.merchant,
    claim.currency,
    claim.amount != null ? `amount ${claim.amount}` : '',
    ...(Array.isArray(claim.items) ? claim.items : []),
    claim.business_purpose,
  ].filter(Boolean).join(' ');
}

export async function retrieveNaiveTop3(claimText: string, cards: Policy[], apiKey: string, k = 3) {
  const cacheKey = cards.map(card => card.policy_id).join('|');
  if (!cardVecCache || cardVecCache.key !== cacheKey) {
    cardVecCache = { key: cacheKey, vecs: await embed(cards.map(cardText), apiKey) };
  }
  const [query] = await embed([claimText], apiKey);
  const scored = cards
    .map((card, index) => ({ card, score: cosine(query, cardVecCache!.vecs[index]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return {
    policy_ids: scored.map(item => item.card.policy_id),
    policy_cards: scored.map(item => item.card),
    selection_reasons: Object.fromEntries(scored.map(item => [item.card.policy_id, [`naive_top${k}_similarity=${item.score.toFixed(3)}`]])),
    flags: [] as string[],
    retrieval_status: 'ready_for_assessment' as const,
    retriever: `naive_top${k}:${EMBED_MODEL}`,
  };
}
