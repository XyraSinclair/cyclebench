# cyclebench — design

> Distilled 2026-07 from the benchmarking harness built inside the priorsio
> repo (2022–2026), where interleaved cycling, args suites, and
> results-agreement checks were developed to compare that repo's own
> utilities honestly. This package is the clean, public restatement.

## 1. The problem, precisely

A comparative microbenchmark estimates E[t_f(x)] for each candidate f over
an input distribution x, on a machine whose throughput is a **nonstationary
process** w(t): background load, thermal throttling, GC cycles, cache and
frequency state. What you observe is t_f(x)·w(t). Any harness that measures
candidate A over window [0, T] and candidate B over [T, 2T] estimates
E[t_A]·E[w | first window] vs E[t_B]·E[w | second window] — the weather term
does not cancel. It is a **confounded experiment**: treatment (candidate)
correlates with time.

The classical fix is the classical fix for every confounded experiment:
**interleave the treatments**. Slice measurement into units short relative
to the weather's timescale and visit candidates round-robin, so every
candidate samples the same weather distribution. Drift then cancels in the
*ratio*, which is the quantity a comparison actually cares about.

The second problem is validity rather than variance: a benchmark presumes
all candidates compute the same function. Nothing enforces this, and the
failure mode is systematically seductive — wrong implementations are often
faster *because* they skip work (the lexicographic `.sort()`, the
memoizer that never invalidates, the "fast path" the JIT deleted whole).
A harness that ranks without verifying agreement will eventually crown one.

## 2. Architecture

The unit of work is a **cell** — one (candidate × input) pair:

```
cells = candidates × inputs
warmup: first clean pass    → async detection, error capture, agreement results
        calibration         → grow k until one slice of k calls ≈ targetSliceMs
        warmup slices       → JIT tiering on the real hot loop
floor:  same machinery over an empty function → floorNs
measure: round-robin over cells; each turn = one timed slice
         sample = slice_ms · 1e6 / k   (ns/op), appended per cell
report: per-cell quartiles → per-candidate aggregation → ranking, ties, caveats
```

Cells (not candidates) are the round-robin unit, so interleaving happens
across inputs too — a candidate cannot be lucky on the input it happened to
run during the quiet phase.

### Slices

`targetSliceMs = 2` balances two pressures: slices must be long enough that
`performance.now()` quantization and the timing call itself are negligible
(µs-resolution timer / 2ms slice ≈ 0.05%), and short enough that many
round-robin cycles fit inside each weather regime. Per-slice ns/op values
form the sample; the median is the estimator (robust to GC pauses landing
inside a few slices) and the interquartile band is the reported spread.

Round-robin over cells is fair in *turns*; fairness in *time* additionally
requires slices to stay near the target. k (calls per slice) is therefore
calibrated during warmup and **re-scaled after any measured slice that
drifts beyond 0.5–2× the target** — calibration can run on a colder JIT
tier than measurement (the function speeds up 5–10× after tier-up), and
without adaptation those stale-k slices would both break interleaving
fairness and overshoot the time budget.

### The hot loop

Two lies to prevent: the engine deleting the workload, and the harness
dominating it.

- Every call's result is stored into a shared 64-slot ring buffer that
  escapes (the module retains it; tests read it). Stores to an escaping
  object cannot be proven dead, so the calls cannot be elided.
- The loop is compiled per arity with `new Function` so arguments spread as
  a direct call — `fn.apply(fn, argsArray)` costs more than many functions
  worth measuring. With the compiled trampoline a virgin call site floors
  at ~0.6ns/op on Apple Silicon under Node 24; the honest polymorphic
  floor (see below) is ~4ns. Under a CSP that bans `unsafe-eval` the
  harness falls back to `apply` and the floor rises — which is fine,
  because the floor is *measured*, not assumed.

### The floor

Before measuring candidates — but **after** their warmup, and after
deliberately feeding each arity's trampoline two distinct empty functions —
the identical machinery times an empty function per used arity. The
ordering and the polymorphization are load-bearing: a floor taken through
a virgin call site is monomorphic, gets inlined, and understates the real
overhead about 7× (0.5ns vs 3.5ns measured), which would let
harness-dominated candidates through uncaveated. Each cell is compared
against its own arity's floor; the reported `floorNs` is the maximum
across used arities. Any candidate with a cell median within 2× of its
floor is caveated — it stays in the table, but the printout shows
"⚠ at floor" instead of a crown, because at that scale the number is the
harness, not the function. A harness that doesn't know its own floor
reports its own overhead as your function's speed — see `probes/dce.mjs`,
where a naive loop reported `(a, b) => a + b` at 0.41ns/op (deleted)
"beating" its twin by 84%.

### Agreement

Before any timing, each candidate runs once per input; per input, results
are partitioned into equality classes (transitivity makes this O(candidates ×
classes) comparisons). Multiple classes → the minority classes are flagged,
`report.ok = false`, and the printed table marks the dissenters. Equality is
pluggable: `'deep'` (default — isoequal, because outputs containing cycles,
Sets, or Maps must compare by structure, not insertion order), `'identity'`,
a custom predicate, or `false` for candidates that are legitimately
nondeterministic (then the check is off and the report says `agrees: null`,
not a silent pass). A custom predicate must be an equivalence relation —
tolerance predicates are not transitive, and a non-transitive predicate
makes the partition depend on candidate order. With a strict majority
class, only the minorities are flagged; when the top classes tie in size
there is no majority to bless, so every class is flagged.

The agreement pass doubles as the DCE anchor: results that were compared
for equality are results the engine had to actually produce.

### Mutation

Every cell shares the caller's input arrays — cloning per call would put an
unbounded, allocation-shaped cost inside the measurement. The consequence:
a candidate that mutates its arguments (in-place sort, splice, property
write) corrupts every subsequent slice *and* every other candidate's data.
This is a validity trap most harnesses silently fall into (the in-place
sort measures "sorting an already-sorted array" from call two onward).
cyclebench snapshots the inputs with `structuredClone` before the clean
pass and re-snapshots after each candidate's first calls; snapshots are
compared clone-to-clone (so structuredClone's prototype-stripping affects
both sides equally), and a detected mutation **throws**, naming the
culprit — a corrupted comparison should not exist, even labeled.
Uncloneable inputs (functions, WeakRefs) skip the check, as do volatile
inputs (two honest pre-run snapshots that already differ — a getter
reading a clock — make mutation indistinguishable from volatility); those
limitations are accepted rather than worked around with a weaker
fingerprint. One asymmetry is deliberate: inputs that *stop* being
cloneable after a candidate's calls were mutated (something inserted a
function), so that case throws rather than disarming — a mutation cannot
disable its own detector.

### Aggregation across inputs

Per-input medians are the ground truth and are always reported. The headline
per-candidate number is the **equally-weighted mean of per-input medians**:
the suite defines the workload, each input counts the same, and the mean
(unlike a median-of-medians) preserves "total time to run the suite once".
Quartile bands aggregate the same way. Ranking sorts by this number;
adjacent candidates whose bands overlap are marked `tiedWithNext` — order
within a tie is not a verdict.

### Async

A thenable first result marks the candidate async; its slices await each
call. This measures real await/scheduler overhead, which is honest — an
async wrapper *is* slower than a sync call, and pretending otherwise would
require subtracting a number nobody can measure per-call. The report labels
async candidates so cross-kind comparisons are read with open eyes. (Floor
caveats effectively never fire for async candidates: the sync-measured
floor is dwarfed by await overhead, which is honestly part of their time.)

### deopt

The priorsio ancestor called `eval('')` between slices to discourage the
JIT from over-specializing the harness loop across candidates. With
per-arity trampolines shared by all candidates the call sites are already
polymorphic, so this is off by default and kept as an opt-in
(`deopt: true`) for paranoid runs.

## 3. What was deliberately left out

- **Hardware counters, flamegraphs, per-iteration histograms** — cyclebench
  is a comparator with a validity check, not a profiler. mitata does the
  instruction-level story well.
- **Statistical hypothesis tests** — a p-value on nonstationary timing data
  is theater. Overlapping interquartile bands are a cruder but honest tie
  criterion.
- **Automatic subtraction of the floor** — reported, never subtracted;
  silent correction is how harnesses drift from measurement to fiction.
- **Suite persistence / regression tracking** — `report.toJSON()` is stable
  and complete; diffing runs over time is a caller's policy decision.

## 4. Known limits

- Warmup budgets well under ~100ms per candidate can straddle JIT tiers;
  calibration on a cold tier then produces oversized early slices until the
  adaptive re-scale corrects k (a few slices). The median resists the
  transient, but for sub-µs candidates keep the default budgets.
- Interleaving cancels drift *between* candidates; it cannot make an
  absolutely noisy machine precise — the spread column tells you what the
  run was worth.
- The 64-slot ring keeps the newest results alive, which slightly favors
  allocating candidates staying in the young generation. All candidates
  share the same ring, so the bias is symmetric.

## 5. Receipts

Every claim above is executable:

- `probes/drift.mjs` — sequential says 1.95× between identical functions;
  cyclebench says 1.03×, tie.
- `probes/disagreement.mjs` — the numeric-vs-lexicographic sort trap;
  ranking refused.
- `probes/dce.mjs` — the naive 0.41ns "addition"; floor measured and shown.
- `src/compare.test.ts` — 24 cases: ranking, agreement classes (including
  the no-majority tie), async, failure isolation (clean-pass and
  late-throwing candidates), mutation detection (including the
  uncloneable-insertion and mutate-on-repeat evasions), floor caveats,
  suite aggregation, report printing (including errored rows), the result
  ring being cleared after a run, formatting.
