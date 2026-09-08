"""ONLINE STAGE — the retrieval pipeline for ClaimGuard AI (member 4).

Implements the pipeline taught in Lecture 5 / the Week-5 lab, applied to
expense-claim pre-screening:

  A  closed-book        no retrieval at all                     (baseline)
  B  naive RAG          one query -> top-k similarity -> LLM     (lab Part 4, naive)
  C  advanced RAG       router -> query decomposition -> metadata
                        filter -> hybrid sparse+dense retrieval ->
                        mandatory-rule injection -> cross-encoder
                        rerank -> context compression -> LLM      (lab Part 4, improved)

Dense retrieval uses sentence-transformers/all-MiniLM-L6-v2 and the
cross-encoder/ms-marco-MiniLM-L6-v2 reranker, exactly as in the lab, when
those packages are installed (Colab). When they are not, the module falls
back to the sparse TF-IDF index alone and says so in `backend()`; every
number this file reports states which backend produced it.
"""
import json
import re
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

HERE = Path(__file__).parent
CARDS = json.loads((HERE / 'policy_cards.json').read_text(encoding='utf-8'))
GENERAL = ['DOC-001', 'GEN-002', 'GEN-003', 'GEN-004']

EMBED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
RERANK_MODEL = 'cross-encoder/ms-marco-MiniLM-L6-v2'
_dense, _reranker = None, None


def _try_dense():
    """Load the lab's models if they are available; otherwise stay sparse."""
    global _dense, _reranker
    if _dense is not None:
        return _dense
    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder
        _dense = SentenceTransformer(EMBED_MODEL)
        _reranker = CrossEncoder(RERANK_MODEL)
    except Exception:
        _dense, _reranker = False, False
    return _dense


def backend():
    return 'hybrid sparse(TF-IDF)+dense(%s), rerank=%s' % (EMBED_MODEL, RERANK_MODEL) \
        if _try_dense() else 'sparse TF-IDF only (dense models unavailable in this environment)'


# ---------------------------------------------------------------- indexing
class SparseIndex:
    """Lecture 5 slide 55: TF-IDF term weighting.

    Strong on exact identifiers and rare terms ('minibar', 'alcohol',
    'SGD 250'), which is precisely where a policy corpus lives.
    """

    def __init__(self, cards):
        self.cards = cards
        corpus = [c['text'] + ' ' + ' '.join(c['tags']) for c in cards]
        self.vec = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True,
                                   token_pattern=r'(?u)\b\w+\b')
        self.M = self.vec.fit_transform(corpus)

    def score(self, query):
        q = self.vec.transform([query])
        return (self.M @ q.T).toarray().ravel()


class DenseIndex:
    """Lecture 5 slide 57 (DPR): encode, then cosine-similarity nearest
    neighbour. Strong when the claim wording differs from the policy wording."""

    def __init__(self, cards):
        self.cards = cards
        self.V = _dense.encode([c['text'] for c in cards],
                               normalize_embeddings=True, convert_to_numpy=True)

    def score(self, query):
        q = _dense.encode([query], normalize_embeddings=True, convert_to_numpy=True)[0]
        return self.V @ q


def _norm(x):
    x = np.asarray(x, dtype=float)
    return (x - x.min()) / (x.max() - x.min()) if x.max() > x.min() else np.zeros_like(x)


class HybridIndex:
    """Lecture 5 slide 31: sparse and dense fail differently, so combine them."""

    def __init__(self, cards, alpha=0.5):
        self.cards, self.alpha = cards, alpha
        self.sparse = SparseIndex(cards)
        self.dense = DenseIndex(cards) if _try_dense() else None

    def search(self, query, top_k, allowed=None):
        s = _norm(self.sparse.score(query))
        score = s if self.dense is None else self.alpha * s + (1 - self.alpha) * _norm(self.dense.score(query))
        order = np.argsort(-score)
        hits = []
        for i in order:
            card = self.cards[i]
            if allowed is not None and card['policy_id'] not in allowed:
                continue
            hits.append({**card, 'score': float(score[i])})
            if len(hits) >= top_k:
                break
        return hits


# ------------------------------------------------- pre-retrieval: the query
def build_query(claim, context):
    """Naive variant B query: one flat string from the whole claim."""
    return ('Expense claim: {category} at {merchant}, {currency} {amount}, dated {date}. '
            'Purpose: {purpose}.').format(
        category=claim.get('category'), merchant=claim.get('merchant'),
        currency=claim.get('currency'), amount=claim.get('amount'),
        date=claim.get('date'), purpose=context.get('business_purpose'))


def decompose(claim, context):
    """Lecture 5 slide 40-42: query decomposition + keyword extraction.

    A claim is not one information need. It is at least four: what is the
    spending limit, what evidence is required, what approval is required,
    and does any exception or special rule apply. One embedding of the whole
    claim averages these away -- the failure the lab demonstrates in Part 4.
    """
    cat = claim.get('category')
    label = {'meal': 'business meal', 'hotel': 'hotel accommodation',
             'transport': 'ground transport', 'airfare': 'flight'}.get(cat, str(cat))
    subs = [
        f'What spending limit applies to a {label} claim?',
        f'What receipt or evidence is required for a {label} claim?',
        'What business purpose and manager approval are required before reimbursement?',
        'What makes a claim a duplicate or a late submission?',
    ]
    if cat == 'meal':
        subs.append('Are alcohol and client entertainment reimbursable, and what attendee details are needed?')
    if cat == 'hotel':
        subs.append('What happens when the room rate is above the nightly cap, and are personal hotel charges claimable?')
    if cat == 'transport':
        subs.append('What are the taxi and late-night travel limits and the route evidence requirement?')
    if cat == 'airfare':
        subs.append('Which cabin class is allowed and when must travel be pre-approved?')
    if claim.get('currency') not in ('SGD', None):
        subs.append('How is a claim in a foreign currency converted and what evidence is needed?')
    if context.get('receipt_lost') is not False:
        subs.append('What happens when the receipt is lost or the receipt status is unknown?')
    return subs


# ------------------------------------------------------- metadata filtering
def metadata_filter(cards, expense_date):
    """Week-5 lab `only_current`, and Lecture 5 failure mode 3 (stale KB).

    Similarity search cannot tell a superseded rule from a current one, so
    version selection happens BEFORE ranking, never as a tie-break after it.
    """
    active, flags = {}, []
    for c in cards:
        if c.get('status') != 'CURRENT':
            continue
        try:
            start = date.fromisoformat(c['effective_date'])
            end = date.fromisoformat(c['expiry_date']) if c.get('expiry_date') else date.max
        except (KeyError, TypeError, ValueError):
            flags.append('invalid_policy_date:' + c.get('policy_id', '?'))
            continue
        if start <= expense_date <= end:
            active.setdefault(c['policy_id'], []).append(c)
    for pid, versions in active.items():
        if len(versions) > 1:
            flags.append('policy_conflict:' + pid)
    return active, flags


# ------------------------------------------ mandatory rules (design decision)
def gate(claim, context, active):
    """Rules that MUST reach the model regardless of similarity score.

    Lecture 5 failure mode 1: 'even a perfect generator cannot use evidence it
    never receives'. For a compliance decision, silently missing the
    duplicate-claim or deadline rule is not an acceptable ranking outcome, so
    those four general cards and every condition-triggered exception are
    injected by rule and exempt from top-k truncation. This is the one place
    where we deliberately do NOT let the retriever decide.

    Completeness is not checked here. Intake validation (layer 1) has already
    guaranteed that every field this function reads is present, which is what
    lets the policy layer stay strictly binary.
    """
    ids, notes = list(GENERAL), []

    def limit(pid, fallback):
        try:
            return Decimal(str(active[pid][0]['limit_sgd']))
        except (KeyError, IndexError, TypeError, InvalidOperation):
            return Decimal(fallback)

    cat = claim.get('category') or context.get('expense_category')

    if cat == 'hotel':
        ids.append('HOTEL-002')
        try:
            nights = int(context.get('hotel_nights'))
            amt = Decimal(str(context.get('claimed_amount', claim.get('amount'))))
            if (context.get('claimed_currency') or claim.get('currency')) != 'SGD':
                amt *= Decimal(str(context.get('fx_rate_to_sgd')))
            if amt > limit('HOTEL-001', 250) * nights:
                ids.append('HOTEL-003')
                notes.append('over_limit_hotel')
        except (TypeError, ValueError, InvalidOperation):
            ids.append('HOTEL-003')
            notes.append('hotel_amount_not_comparable')
    elif cat == 'transport':
        # Mode is a structured field, so the applicable fare card is a lookup,
        # not a ranking problem. Found by test case N01.
        ids.append('TRANSPORT-004')
        mode = context.get('transport_mode')
        if mode == 'public':
            ids.append('TRANSPORT-001')
        elif mode in ('taxi', 'ride_hail'):
            ids.append('TRANSPORT-002')
            if context.get('night_travel') is True:
                ids.append('TRANSPORT-003')
    elif cat == 'meal':
        ids.append('MEAL-002')
        if context.get('client_meal') is True:
            ids.append('MEAL-003')
    elif cat == 'airfare':
        ids += ['AIR-001', 'AIR-002']

    if (context.get('claimed_currency') or claim.get('currency')) not in ('SGD', None):
        ids.append('FX-001')
    if context.get('receipt_lost') is True:
        ids.append('LOST-001')

    return sorted(set(ids)), [], notes


# --------------------------------------------------- post-retrieval: rerank
def rerank(query, cands):
    """Lecture 5 slide 46: retrieve broadly, then judge carefully.

    Cross-encoder when available. The fallback is a lexical cross-score
    (query-term coverage), which is NOT a cross-encoder -- it is labelled as
    such so no report claims a reranker that did not run.
    """
    if not cands:
        return []
    if _try_dense() and _reranker:
        scores = _reranker.predict([(query, c['text']) for c in cands])
        kind = 'cross-encoder'
    else:
        qt = set(re.findall(r'\w+', query.lower()))
        scores = [len(qt & set(re.findall(r'\w+', c['text'].lower()))) / (len(qt) or 1) for c in cands]
        kind = 'lexical-fallback'
    out = [{**c, 'rerank_score': float(s), 'rerank_kind': kind} for c, s in zip(cands, scores)]
    return sorted(out, key=lambda x: -x['rerank_score'])


def compress(query, cards, keep_sentences=8):
    """Lecture 5 slide 48 / lab Improvement 3: extractive sentence selection.

    Keeps citations intact -- every kept sentence carries its policy_id, so
    citation correctness stays measurable after compression.
    """
    rows = []
    for c in cards:
        for s in re.split(r'(?<=[.!?])\s+', c['text']):
            if s.strip():
                rows.append((c['policy_id'], s.strip()))
    if not rows:
        return []
    vec = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, token_pattern=r'(?u)\b\w+\b')
    M = vec.fit_transform([s for _, s in rows])
    sc = (M @ vec.transform([query]).T).toarray().ravel()
    order = np.argsort(-sc)[:keep_sentences]
    return [{'policy_id': rows[i][0], 'sentence': rows[i][1], 'score': float(sc[i])}
            for i in sorted(order)]


# ------------------------------------------------------------- the variants
def retrieve_naive(claim, context, top_k=3):
    """Variant B — the naive RAG the lab asks you to break.

    One query, top-k by similarity, no metadata filter, no mandatory rules,
    no rerank, no compression.
    """
    idx = HybridIndex(CARDS)
    hits = idx.search(build_query(claim, context), top_k)
    return {'variant': 'B_naive_rag',
            'policy_ids': sorted({h['policy_id'] for h in hits}),
            'policy_cards': hits, 'kb_errors': [], 'notes': [],
            'retrieval_status': 'ready_for_assessment'}


def retrieve_advanced(claim, context, per_subquery=2, final_k=8, cards=None):
    """Variant C — the improved pipeline."""
    cards = cards or CARDS
    try:
        expense_date = date.fromisoformat(claim.get('date') or '')
    except (ValueError, TypeError):
        # Intake validation guarantees a real date, so reaching this branch is
        # a caller error, not a claim outcome.
        return {'variant': 'C_advanced_rag', 'policy_ids': [], 'policy_cards': [],
                'selection_reasons': {}, 'subqueries': [], 'compressed': [], 'notes': [],
                'kb_errors': ['invalid_or_missing_expense_date'], 'retrieval_status': 'kb_error'}

    active, meta_flags = metadata_filter(cards, expense_date)
    mandatory, gate_flags, notes = gate(claim, context, active)

    # Second metadata filter, on category. The lab filters on `status`; the
    # structured `category` field that Prompt A already gives us is the same
    # kind of pre-retrieval constraint (Lecture 5 slide 40: map extracted
    # keywords onto structured fields to improve retrieval precision).
    # Without it a meal claim ranks TRANSPORT cards above MEAL-002, because
    # "claim/expense/purpose" wording is shared across all 18 cards.
    cat = claim.get('category')
    allowed = {pid for pid, v in active.items()
               if v[0]['category'] in (cat, 'general', 'special')}

    subqueries = decompose(claim, context)
    idx = HybridIndex([c for c in cards if c['policy_id'] in allowed])
    reasons, pool = {}, {}
    for sq in subqueries:
        for hit in idx.search(sq, per_subquery, allowed):
            pid = hit['policy_id']
            reasons.setdefault(pid, []).append('retrieved:' + sq[:44])
            if pid not in pool or hit['score'] > pool[pid]['score']:
                pool[pid] = hit
    for pid in mandatory:
        if pid in allowed:
            reasons.setdefault(pid, []).append('mandatory_rule')
            pool.setdefault(pid, {**active[pid][0], 'score': 1.0})
        else:
            gate_flags.append('missing_active_policy:' + pid)

    ranked = rerank(build_query(claim, context), list(pool.values()))
    mand = set(mandatory)
    kept = [c for c in ranked if c['policy_id'] in mand] + \
           [c for c in ranked if c['policy_id'] not in mand][:max(0, final_k - len(mand))]

    kb_errors = meta_flags + gate_flags
    return {'variant': 'C_advanced_rag',
            'policy_ids': sorted({c['policy_id'] for c in kept}),
            'policy_cards': kept,
            'selection_reasons': {k: v for k, v in reasons.items()
                                  if k in {c['policy_id'] for c in kept}},
            'subqueries': subqueries,
            'compressed': compress(build_query(claim, context), kept),
            'kb_errors': sorted(set(kb_errors)), 'notes': notes,
            'retrieval_status': 'kb_error' if kb_errors else 'ready_for_assessment'}


if __name__ == '__main__':
    import sys
    payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    print('backend:', backend())
    print(json.dumps(retrieve_advanced(payload['claim'], payload['context']),
                     ensure_ascii=False, indent=2))
