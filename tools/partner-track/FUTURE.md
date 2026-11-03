# Future considerations: Contribution Units v2

Not in the course yet. Notes toward a second version of the Contribution Units paper and, later, the
course modules that teach it. The v1 paper models a venture path (five rounds, 200 people, a $500M
Series C). The plan is different: bootstrap the company to a ~$50M exit, then a self-funded ~$25M
holding company that installs Contribution Units in everything it buys. v2 should fit that plan.

## Keep it investible

The 7% pool stays the default. A structure only one founder will accept stays an experiment; the point
is for other companies and investors to adopt it. Bolder versions can exist, but the template is the
one an investor will sign.

## 1. Distributions

Units share in distributions **only when equity holders are paid**: whenever owners take a
distribution, the pool takes its 7% alongside. Employees are paid when owners are, never ahead.

- Turns a liquidity-event lottery ticket into recurring cash. Most companies never sell.
- Gives a permanent holdco (which never sells) a way to pay out at all.
- Former holders keep receiving distributions (units never forfeit). Plan the admin, or allow an
  optional buyout at appraised value.
- Distributions lower reported profit, which a buyer values. Model the effect on exit price.

## 2. Displacement policy

The hardest open problem. Split it three ways:

**A. People whose roles AI shrinks.** Never-forfeit units already keep their claim. Add:

1. **Displacement credit**: on a no-fault separation (including automation), units keep accruing for
   four quarters as if still employed. Funded inside the 7% pool, so investors aren’t diluted.
   Remaining holders absorb it, which fits the paper’s logic: the corpus that replaced the role is
   what the pool pays for.
2. **Attrition first**: shrink by not backfilling (the model assumes 18%/yr) before any layoff.
3. **Redeploy first**: offer open roles first, especially the ones AI creates (supervising,
   training, handling exceptions).
4. **Standard severance** on top of the credit.

All bounded and predictable, which keeps them investible.

**B. People never hired.** Can’t pay individuals who never existed. Option: a training or
apprenticeship commitment funded by a share of measured AI savings.

**C. The wider workforce.** A policy problem; no company structure solves it. A documented case
(“AI took 30% of the work; here’s what happened to the people”) is still useful evidence.

## 3. The bootstrapped, partial-sale version

- No financing rounds means no top-up rule. Simpler: 7% of proceeds to the pool.
- Rough check at a $50M exit: ~20 people × ~$70K × 6 years ≈ $8.4M of accrued salary; $3.5M pool ≈
  $0.42 per salary dollar; four years at $62K ≈ $100K (~1.7× pay). Close to v1’s “two years of pay”.
- **Partial liquidity is the gap.** A PE recap (buyer takes part, founders roll the rest) must pay
  the pool its 7% of cash distributed, then the rest at the final sale. Define “proceeds” precisely
  (debt, fees, escrows, indemnity holdbacks).

## 4. Legal structure (decide before incorporating)

| Structure | For | Against |
|---|---|---|
| Real stock (C-corp) | Capital-gains treatment for employees | Fully vested grants are taxed at receipt, every quarter, on stock they can’t sell; needs ongoing valuations; hundreds of ex-employees on the cap table |
| LLC profits interests | No tax at grant; capital gains; partial distributions are natural | Employees become partners (K-1s; partners generally can’t be W-2 employees), usually fixed with a holding-company layer |
| Phantom plan (contract right to 7% of proceeds) | Simplest; no upfront tax, no securities filings; buyers know these plans | Ordinary income at payout; payout timing must fit Section 409A, which makes partial sales harder |

Likely fit: C-corp for founder and investors (QSBS: up to $15M of gain excluded on stock held 5+ years,
under the 2025 rules) with Contribution Units run as a phantom plan. Get a startup tax lawyer before
incorporating; partial liquidity is where the choice bites.

Also decide:

- **Forfeiture for fraud?** v1 says never. Most plans keep a narrow proven-fraud exception.
- **Contractors**: do they accrue? A solo bootstrapped start leans on them early.
- **280G** on a C-corp sale: large executive payouts can trigger penalty taxes. Private companies
  cleanse it with a shareholder vote.
- **Investors sign on to the plan in their investment documents** from the first check.

## 5. Spreading it

The SAFE is the precedent: it spread because YC made it free and standard. Same playbook:

1. Prove it in the company: real payouts, documented (“our support lead got 1.9× salary”).
2. Publish the documents free: plan document, employee explainer, purchase-agreement language.
3. Solve the hard parts in public: tax, partial sales, permanent holdcos, PE buyouts.
4. Install it in every company the holdco buys.

Look at **Ownership Works** (Pete Stavros, KKR, 2021): broad-based ownership across PE portfolio
companies; CHI Overhead Doors staff reportedly averaged ~$175K at the 2022 sale. Proof the model works
in PE, and a likely ally. What’s different here: the AI-era rationale (people build durable value and
keep a stake in it), never-forfeit, and automatic salary-proportional accrual with no discretion.

## 6. The holdco

- Self-funded (own capital only) mostly avoids investment-adviser registration.
- Permanent capital (Constellation, Berkshire) suits a long-horizon ownership experiment better than a
  10-year fund clock, and needs the distribution mechanism above.
- Concentration: $25M may be most of the after-tax proceeds from a $50M exit. Size it deliberately.

## Before v2 is published

- Check the v1 §2 support-AI example (60% → 80% resolution, hiring stopped). If it came from an
  employer, make it generic. The v1 artifact is currently shared with anyone who has the link.
