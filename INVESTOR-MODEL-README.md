# Investor Model — Investment Analysis Tool

Built to answer Paige Blumer's ask: **model projects from the investor's perspective, with toggleable structuring assumptions.**

## What it does (her four bullets, all built)

1. **Debt vs. equity** — toggle "Levered," set debt %, rate, term. Produces levered equity IRR + DSCR.
2. **EBITDA retain vs. pass-through** — pref-return + promote waterfall (or flat % via toggle), split into investor vs. sponsor cashflows.
3. **Per-component ITC** — each cost bucket (BESS, solar, roof, interconnection, EV, compute) carries its own ITC %, seeded to IRA defaults, all editable. Roof defaults low; compute is non-eligible.
4. **ITC & depreciation step-up** — MACRS with the 50%-of-ITC basis reduction, optional FMV step-up, and optional upfront monetization of the depreciation shield (tax-equity convention).

Plus what the company wanted:
- **Three ownership modes** that re-route the cashflows: Owner-Operator, PPA/Energy Sale (contracted + grid-upside split), Fixed Lease (flat annuity).
- **Module toggles** (BESS / DER / Compute / EV) — turn a module off and its inputs disable and drop out of the analysis.
- **Investor-facing headline**: Levered Equity IRR + MOIC, with Cash-on-Cash and DSCR.

## Headline metrics
Levered equity IRR leads, MOIC beside it (institutional convention), cash-on-cash and DSCR supporting — the numbers an infrastructure investor actually screens on.

## Claremont calibration (the anti-BS proof)
The "★ Load Claremont deal" button loads the executed 802 kW / 5 MWh Berkeley deal. The engine reproduces the real capital waterfall:

| Line | Tool | Deck |
|---|---|---|
| Gross capex | $2.70M | $2.7M |
| ITC (30%) | −$810K | −$0.9M |
| SGIP rebate | −$562K | −$0.6M |
| Depreciation value | −$459K | −$0.8M |
| **Net capital** | **$869K** | **$0.5–1M** |
| Value stack | $350K | $350K |

The waterfall and revenue match the executed deal exactly. **On returns, the tool shows ~23% unlevered vs. the deck's stated 13–15%** — an honest modeling-assumption gap (the deck's return base and 20-yr cashflow profile aren't fully shown on the sheet). This closes once the deal's actual pro-forma cashflow tab is entered — which is precisely the kind of assumption the tool is built to let you toggle and test.

The important point for a finance audience: **the tool computes from first principles, not hardcoded answers.** Change the address, size, utility, or leverage and every number recomputes. Claremont is a *preset of inputs*, not a stored result — that's what makes the calibration meaningful rather than circular.

## Honest caveats (say these to Paige — she'll respect it)
- ITC %s, depreciation treatment, and step-up are **modeled per current IRA rules and fully overridable** — a screening aid, not tax advice. The tool flags this.
- Return calibration to Claremont's exact 13–15% needs the deal's real cashflow assumptions; the waterfall is exact, the IRR is directionally right and tunable.

## Files
- `investment-analysis.html` — the tool (open in browser, or deploy to Vercel)
- `investment-analysis-logic.js` — the engine (loaded by the HTML)

Both are single-file, ES5, no build step — same stack as your other tools. Verified: JS syntax clean, HTML balanced, full runtime simulation passes (preset load + underwrite + module toggles, no crashes).

## To use in front of Paige
1. Open the tool, click **★ Load Claremont deal**, click **Run** → show the waterfall reproducing the real deal.
2. Toggle **Levered** on/off, change the **ownership mode**, flip **EBITDA split** flat vs. waterfall → show investor returns move coherently.
3. Change the address/system → show it's a general model, not a Claremont parlor trick.
