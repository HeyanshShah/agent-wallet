# Contributing

Thanks for helping make AI agents safer to pay with.

## Setup

```bash
npm install
npm test          # all tests
npm run typecheck
npm run dev       # server on http://localhost:3000, restarts on changes
```

Use `PRICE_CHECK=demo` to try price checks without an API key. `npm run demo` (with `OWNER_TOKEN` set) walks through every outcome.

## Good first contributions

- **More scam patterns** in `src/risk.ts`, each with a test in `test/risk.test.ts`
- **New card issuers** behind the `CardIssuer` interface in `src/cards.ts` (Stripe Issuing, Marqeta, Highnote)
- **New price sources** behind `PriceLookup` in `src/prices.ts`
- **Agent framework examples** in `docs/INTEGRATE.md` (LangChain, OpenAI Agents SDK, CrewAI)
- **Feedback on the [Agent Spend Protocol](docs/AGENT-SPEND-PROTOCOL.md)**, as issues

## Pull requests

- Keep each one focused, and add tests for behavior changes. The rules, risk and price logic are pure functions, so they're easy to test.
- CI runs the typecheck and the tests on every PR.
- Never log or store real card numbers in new code. See the note under "Cards" in the README.

## Security

If you find a security issue, please open a private security advisory on GitHub instead of a public issue.
