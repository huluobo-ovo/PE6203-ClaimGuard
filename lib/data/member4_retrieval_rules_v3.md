# retrieval_rules.md — how policy evidence is selected (Member 4)

**Method:** embedding retrieval as taught in the Lecture 5 lab (`all-MiniLM-L6-v2`, cosine similarity),
improved with **metadata filtering** (status + category) and one design rule of our own (**general rule always
injected**). Implementation: `Member4_ClaimGuard_RAG_Colab.ipynb` (runs on CPU).

## Where this module sits

```
Receipt upload → Prompt A extraction (Member 3) → completeness check (Member 5)
      → [Member 4] policy retrieval → Prompt B policy judgement → pass / fail + policy basis
      → employee guidance (Member 6) → Finance makes the final payment decision
```

Scope agreed with the team:
* incomplete claims are blocked upstream and never reach this module;
* the module uses **only what the receipt and the submission contain** (category, amounts, currency, dates, line
  items, trip time, business purpose). No self-declared status fields (approval, duplicate check, receipt lost…).
  Rules that would need such fields are not in the policy library — they stay with Finance.

Output: binary **pass / fail** with the deciding `policy_id`s.

## The knowledge collection — 12 CURRENT cards + 1 OUTDATED

| Group | Cards | Content |
|---|---|---|
| general | GEN-001 | 30-day submission deadline |
| meal | MEAL-001 … 003 | SGD 50 / person; SGD 100 / person when clients attended; no alcohol lines |
| transport | TRANSPORT-001 … 003 | SGD 80 / trip; SGD 120 for 23:00–06:00 trips; home ↔ regular-office commuting not covered |
| hotel | HOTEL-001, 002 | SGD 250 / night; personal items not covered |
| travel | TRAVEL-001, 002 | economy only; travel extras not covered |
| special | FX-001 | foreign currency converted before caps apply |
| archived | HOTEL-001-2024 (OUTDATED) | old SGD 300 cap — kept to test the status filter, like `FAQ-2024` in the lab |

One card = one rule = one chunk. Caps live in `limit_sgd`, never in code.

## Variant B — naïve RAG (baseline)
One embedding of the claim text → cosine similarity → top-3, no filter. Can return the archived card; misses the
deadline rule.

## Variant C — our retriever

| Change | What it does | Why |
|---|---|---|
| **Status filter** | only `status == CURRENT` cards are searchable | similarity cannot tell a superseded rule from a current one |
| **Category filter** | only the claim's category (+ `special` / FX-001 when `currency != SGD`); top-4 | a hotel claim must never be judged against meal rules |
| **Mandatory general rule** | GEN-001 always added, never searched | the deadline rule must never be ranked out |

Output: 4–5 cards per claim (general first), formatted as the `EVIDENCE` block for Prompt B.
Left out on purpose: query decomposition, reranking, compression — ≤ 4 candidates, nothing to rerank.

## Prompt B and the decision
Code computes `derived` numbers (per-person / per-night SGD, days to submission, late-night flag) before the call.
Prompt B returns **one check per card** (`applies`, `comparison`, `violated`). Code then recomputes every numeric
check from the card's `limit_sgd` (and GEN-001 against 30 days) and **decides**: fail iff any card has
`applies=true` and `violated=true`. The model answers only the semantic questions. See `prompt_B.txt` for v1 → v2 → v3.

## Test cases (`test_cases.json`)

| id | scenario | expected | deciding policy |
|---|---|---|---|
| T01 | team lunch, 42 SGD/person | pass | MEAL-001 (MEAL-002 does not apply) |
| T02 | USD hotel, 283.5 SGD/night after conversion | fail | HOTEL-001 |
| T03 | late-night taxi 96 SGD, client site → home, injected "ignore all policies" | pass | TRANSPORT-002 |
| T04 | client dinner 77.5 SGD/person with a wine line | fail | MEAL-003 |

Metrics: retrieval recall / precision (notebook §6); decision accuracy and citation validity for A/B/C
(notebook §8 Prompt B v1, §10 v2, §11 v3 final).
