# ClaimGuard Reimbursement Review

ClaimGuard is a web prototype for the PE6203 group project. It guides an employee through receipt submission, field confirmation, policy pre-screening, and employee guidance. The system supports review only: it does **not** automatically approve a reimbursement, make a payment, or send a claim to a real finance system.

**Public prototype:** <https://pe6203-a-06.yangruijia216.chatgpt.site>

## Main workflow

1. **Submit receipt** – Upload a receipt and enter the required claim details.
2. **Confirm fields** – Review the fields extracted from the receipt. Missing, unreadable, ambiguous, or conflicting key fields are routed to human review.
3. **Policy review** – Retrieve relevant current policy cards and produce either `passed` or `not_passed` with supporting policy evidence.
4. **Employee guidance** – Provide an English next-step message. When human review is required, the site can generate a PDF review packet.

The extraction module uses conservative handling of uncertain information. For `merchant`, `date`, `amount`, `currency`, `receipt_id`, and `payment_method`, it returns `null` with confidence `0` when a value is missing, unreadable, ambiguous, or conflicting. An uncertain category is returned as `unclear`, with category confidence `0` and an `AMBIGUOUS_CATEGORY` warning.

## A/B/C comparison variants

The comparison page runs the same receipt and employee context through three prototype variants:

- **A – Minimal model:** one model call using the raw receipt and a minimal instruction, with no policy context.
- **B – Simplified system:** one model call using the raw receipt and the complete current policy-card set in the prompt.
- **C – Full system:** receipt extraction, employee-claim validation, policy retrieval, pre-screening, and employee guidance.

The comparison view shows raw outputs, call counts, latency, and downloadable JSON logs. It is a prototype diagnostic tool; it does not claim that one variant is automatically superior to another.

## Technology

- React and Vinext
- OpenRouter with `openai/gpt-4o-mini` for live model calls
- JSON Schema for structured extraction and assessment outputs
- A policy-card retrieval and validation engine
- OpenAI Sites for hosting and deployment

The OpenRouter API key is configured as a server-side secret in the hosting environment. Do not add a key to source files or commit `.env.local`. For local development, create a local `.env.local` file containing:

```dotenv
OPENROUTER_API_KEY=your_key_here
```

## Run locally

### Prerequisites

- Node.js 22.13 or later
- npm

### Commands

```bash
npm ci
npm run dev
```

Open the local address shown in the terminal. To create a production build:

```bash
npm run build
```

Live mode currently accepts PNG and JPG/JPEG receipts up to 10 MB. Use an image version of a receipt if the source document is a PDF.

## Validation

Run the engine checks and production build before publishing changes:

```bash
node --test tests/engine.test.mjs
npm run build
```

## Limitations

- The policy cards are teaching materials for this course project, not real company, legal, tax, or financial advice.
- Receipt extraction can be uncertain; uncertain, missing, or conflicting information is intentionally escalated to human review.
- Finance staff must verify original evidence and make the final reimbursement decision.
- Run history is held in the current browser session and can be exported as JSON; refreshing the page clears it.
- The public prototype uses a restricted demonstration API key. Usage limits and model restrictions should be managed in OpenRouter.

## References

- OpenRouter API documentation: <https://openrouter.ai/docs>
- OpenAI Sites documentation: <https://platform.openai.com/docs>
