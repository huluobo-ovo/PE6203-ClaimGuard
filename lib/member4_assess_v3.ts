// lib/member4_assess_v3.ts
// Member 4 · Prompt B v3 support: field whitelist + derived numbers + per-card checks schema + code-side decision.
// The LLM answers only semantic questions (does a card apply? is there an alcohol / personal-item line?);
// every numeric comparison and the final pass/fail are computed here from the card's own limit_sgd.

import type { Data, Assessment, Policy } from '@/lib/engine';

// ---------- 1. Whitelist: only receipt + submission facts reach Prompt B ----------
// Self-declared statuses (preapproval_status, manager_approval, duplicate_check, itemized_receipt,
// receipt_lost, evidence_refs, route_evidence_present, attendee_details_present) are NEVER sent.
export function claimForPromptB(claim: Data, ctx: Data): Data {
  const c: Data = {
    category: claim.category,
    currency: claim.currency,
    amount: claim.amount,
    merchant: claim.merchant,
    receipt_id: claim.receipt_id,
    items: claim.items ?? claim.line_items ?? [],
    expense_date: claim.date,
    submission_date: ctx.submitted_date,
    business_purpose: ctx.business_purpose,
  };
  const fx = typeof ctx.fx_rate_to_sgd === 'number' && ctx.fx_rate_to_sgd > 0 ? ctx.fx_rate_to_sgd : null;
  c.amount_sgd = claim.currency !== 'SGD' && fx ? Math.round(claim.amount * fx * 100) / 100 : claim.amount;
  if (fx) c.fx_rate = fx;
  if (Number.isInteger(ctx.hotel_nights) && ctx.hotel_nights > 0) c.nights = ctx.hotel_nights;
  if (Number.isInteger(ctx.attendee_count) && ctx.attendee_count > 0) c.persons = ctx.attendee_count;
  if (ctx.client_meal === true) c.clients_attended = true;
  if (ctx.contains_alcohol === true) c.alcohol_on_receipt = true;
  if (ctx.personal_items_present === true) c.personal_items_on_receipt = true;
  if (ctx.transport_mode) c.transport_mode = ctx.transport_mode;
  if (typeof ctx.trip_start_time === 'string') c.trip_start_time = ctx.trip_start_time;   // "23:40"
  else if (ctx.night_travel === true) c.trip_start_time = '23:30';                         // form only has a yes/no flag
  if (ctx.flight_class) c.flight_class = ctx.flight_class;
  return c;
}

// Same whitelist for the single-call baselines (no extraction available yet, so context only).
const BASELINE_DROP = new Set(['preapproval_status', 'manager_approval', 'duplicate_check', 'itemized_receipt',
  'receipt_lost', 'evidence_refs', 'route_evidence_present', 'attendee_details_present']);
export function contextForBaseline(ctx: Data): Data {
  return Object.fromEntries(Object.entries(ctx || {}).filter(([k, v]) => !BASELINE_DROP.has(k) && v !== null && v !== undefined));
}

// ---------- 2. Numbers are computed by code, never by the model ----------
export function addDerived(c: Data): Data {
  const d: Data = {};
  if (c.persons > 0) d.per_person_sgd = Math.round((c.amount_sgd / c.persons) * 100) / 100;
  if (c.nights > 0) d.per_night_sgd = Math.round((c.amount_sgd / c.nights) * 100) / 100;
  if (c.expense_date && c.submission_date)
    d.days_from_expense_to_submission = Math.round((Date.parse(c.submission_date) - Date.parse(c.expense_date)) / 86400000);
  if (typeof c.trip_start_time === 'string') {
    const h = parseInt(c.trip_start_time.slice(0, 2), 10);
    d.late_night_trip_23_to_06 = h >= 23 || h < 6;
  }
  return { ...c, derived: d };
}

// ---------- 3. Model output schema: one check per card, NO decision (strict-mode compatible) ----------
export const CHECKS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['checks', 'reason', 'next_action'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['policy_id', 'applies', 'why_applies', 'comparison', 'violated'],
        properties: {
          policy_id: { type: 'string' },
          applies: { type: 'boolean' },
          why_applies: { type: 'string' },
          comparison: { type: 'string' },
          violated: { type: 'boolean' },
        },
      },
    },
    reason: { type: 'string' },
    next_action: { type: 'string' },
  },
};

export function evidenceBlock(cards: Policy[]) {
  return cards.map(c => `[${c.policy_id}] ${c.title}: ${c.rule}`).join('\n');
}

// ---------- 4. Code compares every numeric cap with the card's own limit_sgd and decides ----------
const UNIT: Record<string, string> = { meal: 'per_person_sgd', hotel: 'per_night_sgd' }; // transport / travel: per trip = amount_sgd

export type Check = { policy_id: string; applies: boolean; why_applies: string; comparison: string; violated: boolean };

export function finalizeV3(out: any, claim: Data, cards: Policy[]): { assessment: Assessment; checks: Check[] } {
  const byId: Record<string, Policy> = Object.fromEntries(cards.map(c => [c.policy_id, c]));
  const d: Data = claim.derived || {};
  const checks: Check[] = ((out && out.checks) || []).filter((ch: any) => ch && byId[ch.policy_id]);   // drop invented IDs
  for (const ch of checks) {
    const card = byId[ch.policy_id];
    if (!ch.applies) { ch.violated = false; continue; }
    if (typeof card.limit_sgd === 'number') {                              // numeric cap → code compares
      const value = d[UNIT[card.category] ?? ''] ?? claim.amount_sgd;
      ch.violated = value > card.limit_sgd;
      ch.comparison = `${value} ${ch.violated ? '>' : '<='} ${card.limit_sgd}`;
    } else if (ch.policy_id === 'GEN-001') {                               // 30-day deadline → code compares
      const days = d.days_from_expense_to_submission;
      ch.violated = typeof days === 'number' ? days > 30 : false;
      ch.comparison = `${days} ${ch.violated ? '>' : '<='} 30`;
    }                                                                       // else: alcohol / personal items / cabin class → model's semantic call stands
  }
  const violated = checks.filter(c => c.applies && c.violated).map(c => c.policy_id);
  const applied = checks.filter(c => c.applies).map(c => c.policy_id);
  const passed = violated.length === 0;
  const assessment: Assessment = {
    status: passed ? 'passed' : 'not_passed',
    policy_ids: passed ? applied : violated,
    rationale: passed
      ? 'All applicable rules satisfied: ' + checks.filter(c => c.applies && c.comparison !== 'n/a').map(c => `${c.policy_id} ${c.comparison}`).join('; ')
      : String((out && out.reason) || 'At least one applicable policy is violated.'),
    missing_evidence: [],
    uncertainty: [],
    next_action: passed ? 'Submit the claim to Finance for final review.' : String((out && out.next_action) || 'Correct the listed policy issues and resubmit.'),
  };
  return { assessment, checks };
}
