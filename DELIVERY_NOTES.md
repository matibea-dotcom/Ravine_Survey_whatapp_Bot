# Ravine Dairy Bot — GitHub Update

Extract locally, drag the *contents* of `github-repo/` into your emptied
GitHub repo as one upload (not the folder itself).

## What changed — a confirmed, serious bug fix in the numeric validator

**Root cause found by tracing the exact real submission** (REF-MUF983P3,
"Daima: Reg 50061, Promo 200500500"):

The old numeric validator stripped every non-digit character from an
answer and treated whatever digits remained as the number — with no
check that the input was actually meant to be a single number. When an
agent replied `"Kinagop fino\n500ml@61"` to a simple regular-price
question (almost certainly meant for a different, later free-text
question), the validator silently concatenated "500" and "61" into
50061 and accepted it as a real price. The promo price entry
(`"Daima 200ml\nKinagop fino 500ml\nLisha 500ml"` → 200500500) is the
exact same failure mode.

**Fixed**: numeric answers must now be a single coherent number on one
line (optionally with a currency prefix like "KES" or suffix like "/-"),
or they're rejected with a clear message asking the agent to re-enter.
Multi-line input and text containing multiple separate numbers are both
rejected outright, rather than mangled into a nonsense value.

**Also included from the prior round**: a sanity ceiling (max 20,000) on
competitor regular/promo price entries specifically, for the case where
a single plausible-looking number is still implausibly high for a
per-unit price.

**Verified**: reproduced both exact bogus values from the real log,
confirmed both are now rejected; tested every legitimate format that
needs to keep working (plain numbers, decimals, comma-grouped thousands,
currency prefixes, trailing "/-") — all still pass; ran a full
submission end to end including large-but-legitimate values like an
outstanding balance of 1,500; confirmed GT, MT, and HQ all still submit
correctly.
