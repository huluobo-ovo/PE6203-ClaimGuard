"""LAYER 1 — Intake validation.

Decides whether a claim carries enough trustworthy information to be assessed
against policy at all. Nothing incomplete, conflicting or adversarial reaches
the policy layer, which is why the policy layer can be strictly binary.

    accepted  -> the claim goes on to retrieval and policy assessment
    blocked   -> the claim is returned to the employee with a list of what to fix

A block is NOT a rejection of the claim. It says the system cannot yet judge it.
That distinction is the whole reason this layer exists: without it, an unknown
field would have to be resolved as either "passed" or "not passed", and both
would be fabricated.

Design rule: null means UNKNOWN, false means a CONFIRMED NEGATIVE. Only unknown
blocks. A confirmed negative is information, and the policy layer acts on it.
"""
import re
from datetime import date
from decimal import Decimal, InvalidOperation

# Required for every claim, whatever the category.
ALWAYS_REQUIRED = [
    ('expense_date', 'Expense date'),
    ('expense_category', 'Expense category'),
    ('claimed_amount', 'Claimed amount'),
    ('claimed_currency', 'Claim currency'),
    ('business_purpose', 'Business purpose'),
    ('itemized_receipt', 'Itemized receipt on file'),
    ('duplicate_check', 'Historical duplicate check'),
    ('manager_approval', 'Manager approval status'),
    ('receipt_lost', 'Receipt present or declared lost'),
]

# Required once the category is known.
BY_CATEGORY = {
    'meal': [('attendee_count', 'Number of attendees'),
             ('contains_alcohol', 'Whether the amount includes alcohol'),
             ('client_meal', 'Whether this is a client meal')],
    'hotel': [('hotel_nights', 'Number of nights'),
              ('personal_items_present', 'Whether personal hotel items are included')],
    'transport': [('transport_mode', 'Transport mode'),
                  ('route_evidence_present', 'Route evidence on file')],
    'airfare': [('flight_class', 'Cabin class'),
                ('preapproval_status', 'Pre-approval obtained before travel')],
}

SUPPORTED = ('meal', 'transport', 'hotel', 'airfare')
ATTACK_PHRASES = ('ignore all', 'ignore polic', 'bypass', 'approve regardless',
                  'disregard the polic', '忽略政策', '直接批准', '绕过')
LOW_CONFIDENCE = Decimal('0.75')


def _missing(value):
    """Unknown. A blank string is unknown; False and 0 are answers, not blanks."""
    return value is None or (isinstance(value, str) and not value.strip())


def validate(claim, context):
    """Return {'intake_status', 'blocks', 'notes'}.

    `blocks` entries are {'code', 'field', 'message'} so the UI can point at the
    field it needs and the report can count block reasons by code.
    """
    claim = claim if isinstance(claim, dict) else {}
    context = context if isinstance(context, dict) else {}
    blocks, notes = [], []

    def block(code, field, message):
        if not any(b['code'] == code and b['field'] == field for b in blocks):
            blocks.append({'code': code, 'field': field, 'message': message})

    # --- 1. required fields -------------------------------------------------
    for field, label in ALWAYS_REQUIRED:
        if _missing(context.get(field)):
            block('missing_required_field', field, f'{label} is required.')

    cat = context.get('expense_category') or claim.get('category')
    if cat is not None and cat not in SUPPORTED:
        block('unsupported_category', 'expense_category',
              f'This system covers {", ".join(SUPPORTED)} only.')
    elif cat in BY_CATEGORY:
        for field, label in BY_CATEGORY[cat]:
            if _missing(context.get(field)):
                block('missing_category_field', field, f'{label} is required for a {cat} claim.')
        if cat == 'meal' and context.get('client_meal') is True \
                and _missing(context.get('attendee_details_present')):
            block('missing_category_field', 'attendee_details_present',
                  'Attendee names and organizations are required for a client meal.')
        if cat == 'transport' and context.get('transport_mode') in ('taxi', 'ride_hail') \
                and _missing(context.get('night_travel')):
            block('missing_category_field', 'night_travel',
                  'Whether the journey was between 23:00 and 06:00 is required for a taxi claim.')

    # --- 2. conditional requirements ---------------------------------------
    cur = context.get('claimed_currency') or claim.get('currency')
    if isinstance(cur, str) and cur != 'SGD':
        for field, label in (('fx_rate_to_sgd', 'Documented conversion rate'),
                             ('fx_evidence_present', 'Bank or payment record for the rate')):
            if _missing(context.get(field)):
                block('missing_fx_evidence', field, f'{label} is required for a non-SGD claim.')
    if context.get('receipt_lost') is True and not context.get('evidence_refs'):
        block('missing_lost_receipt_evidence', 'evidence_refs',
              'A lost-receipt claim requires a declaration and alternative payment evidence.')

    # --- 3. format ----------------------------------------------------------
    for field in ('expense_date', 'submitted_date'):
        v = context.get(field)
        if isinstance(v, str) and v.strip():
            try:
                date.fromisoformat(v)
            except ValueError:
                block('invalid_date', field, f'{field} is not a real calendar date.')
    if isinstance(cur, str) and not re.fullmatch(r'[A-Z]{3}', cur):
        block('invalid_currency', 'claimed_currency',
              'Currency must be a three-letter uppercase ISO code.')

    # --- 4. human-vs-machine cross-check ------------------------------------
    # A conflict blocks because the system cannot tell which side is right, and
    # extraction misreads as often as people mistype. The employee resolves it.
    pairs = [('claimed_amount', 'amount', 'amount_conflict', 'Claimed amount'),
             ('expense_date', 'date', 'date_conflict', 'Expense date'),
             ('claimed_currency', 'currency', 'currency_conflict', 'Currency'),
             ('expense_category', 'category', 'category_conflict', 'Expense category')]
    for ctx_field, claim_field, code, label in pairs:
        a, b = context.get(ctx_field), claim.get(claim_field)
        if _missing(a) or b is None:
            continue
        if ctx_field == 'claimed_amount':
            try:
                da, db = Decimal(str(a)), Decimal(str(b))
            except (InvalidOperation, ValueError, TypeError):
                block('amount_not_comparable', ctx_field, 'Claimed amount is not a number.')
                continue
            if da != db:
                block(code, ctx_field,
                      f'{label} {da} does not match the receipt total {db}. '
                      'Correct it, or state why they differ.')
        elif a != b:
            block(code, ctx_field, f'{label} does not match the receipt ({b}).')

    # --- 5. trust ------------------------------------------------------------
    text = str(context.get('business_purpose') or '').lower()
    if claim.get('attack_detected') or any(p in text for p in ATTACK_PHRASES):
        block('untrusted_input', 'business_purpose',
              'The claim text contains an instruction to the system. '
              'Remove it and describe the business purpose only.')

    conf = claim.get('field_confidence') or {}
    weak = [f for f in ('merchant', 'date', 'amount', 'currency', 'category')
            if _to_dec(conf.get(f)) is not None and _to_dec(conf.get(f)) < LOW_CONFIDENCE]
    if weak:
        block('low_extraction_confidence', ','.join(weak),
              'The receipt could not be read reliably for: ' + ', '.join(weak) +
              '. Confirm or correct these fields.')

    return {'intake_status': 'blocked' if blocks else 'accepted',
            'blocks': blocks, 'notes': notes}


def _to_dec(v):
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


if __name__ == '__main__':
    import json
    import sys
    payload = json.loads(open(sys.argv[1], encoding='utf-8').read())
    print(json.dumps(validate(payload['claim'], payload['context']),
                     ensure_ascii=False, indent=2))
