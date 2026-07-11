# cyclebench

Comparative benchmarking that **interleaves** candidates to cancel machine
drift, **cross-validates** their results, and refuses to crown a function
that computes the wrong thing.

```ts
import { compare } from 'cyclebench'

const report = await compare({
    candidates: {
        native: (a, b) => a.filter((x) => b.includes(x)),
        viaSet: (a, b) => { const s = new Set(b); return a.filter((x) => s.has(x)) },
    },
    inputs: [[small, small2], [big, big2]], // a suite, not a point
})
report.print()
```

```
candidate  time/op  spread  ops/s   vs fastest
───────────────────────────────────────────────
viaSet     175µs    ±32%    5.7k/s  fastest
native     6.31ms   ±3%     158/s   36×
harness floor 0.587ns/op · 2 inputs · results agree
viaSet: [0] 1.57µs  [1] 349µs
native: [0] 1.8µs   [1] 12.6ms
```

(Regenerate with `node probes/readme-example.mjs`. Note the per-input rows:
at 100 elements the candidates are nearly tied; at 10,000 they are 36× apart
— a single-input benchmark would have averaged that story away.)

## Why this library exists

Three ways every quick benchmark lies, each with a reproducible probe in
this repo (Node 24, Apple Silicon):

**1. Machine drift** (`node probes/drift.mjs`). A sequential harness — bench
A fully, then B — integrates each candidate over *different weather*:
background load, thermal state, GC pressure. Give a sequential harness two
**identical** functions on a machine that gets busy halfway through:

|  | first | second | verdict |
|---|---|---|---|
| sequential harness | 1.1µs | 2.1µs | "1.90× slower" — **a lie** |
| cyclebench | 1.09µs | 1.13µs | 1.04×, statistical tie — the truth |

cyclebench runs every (candidate × input) cell in ~2ms slices, round-robin,
so every candidate sees the same weather. This is the oldest idea in
experimental design — interleave your treatments — and almost no JS harness
does it.

**2. Wrong answers are fast** (`node probes/disagreement.mjs`). A benchmark
of functions that don't compute the same thing is a race between a right
answer and a wrong one. cyclebench deep-compares every candidate's outputs
(via [isoequal](https://github.com/XyraSinclair/isoequal), so cyclic and
unordered outputs compare correctly) before ranking:

```
numericSort  74.7µs   fastest
defaultSort  121µs    1.62×       ✗ DISAGREES
DISAGREEMENT on input 0: {numericSort} vs {defaultSort}
report.ok === false
```

**3. The JIT deletes your workload** (`node probes/dce.mjs`). Below a few
nanoseconds a harness measures itself, not your function. A naive loop
timing two identical one-line additions reported **0.41ns vs 2.64ns — an
"84% winner" between two copies of `a + b`** (the first was optimized
away). cyclebench compiles per-arity trampolines that sink every result
into an escaping ring buffer, measures its own floor with an empty function
(~0.57ns), reports it on every run, and flags any candidate within 2× of it
as unmeasurable rather than ranking it.

## What a fair comparison means here

- **Interleaved**: ~2ms calibrated slices, round-robin over every
  (candidate × input) cell until each cell's time budget is met.
- **Verified**: before measuring, every candidate runs once per input and
  the results are partitioned into equality classes; minority classes are
  flagged, `report.ok` goes false, and the printout says so. Benchmarks
  and correctness are one act, not two.
- **A suite, not a point**: `inputs` is a list of argument tuples — measure
  the distribution you actually face. Per-input medians are reported
  (`report.candidates[i].perInput`), so crossovers are visible instead of
  averaged away; the headline number weights inputs equally.
- **Ties are ties**: per-slice samples give a median and interquartile band;
  adjacent candidates with overlapping bands are marked a statistical tie.
  cyclebench would rather say "same" than invent a 3% winner.
- **Failure is data**: a throwing candidate is reported with its error and
  excluded from ranking; the run survives.

## API

```ts
const report = await compare({
    candidates,            // Record<string, fn> | fn[]
    inputs?,               // args tuples; default [[]]
    timeMs?,               // measured ms per candidate, default 500
    warmupMs?,             // JIT warmup + slice calibration, default 100
    targetSliceMs?,        // slice duration, default 2
    agree?,                // 'deep' | 'identity' | ((a,b)=>boolean) | false
    deopt?,                // opt-in (0,eval)('') between slices
})

report.candidates          // ranked; nsPerOp, opsPerSec, band, perInput, agrees, caveat…
report.ok                  // all ranked candidates agreed, none threw
report.disagreements       // equality classes per input, majority first
report.floorNs             // this run's measurement floor
report.print({ perInput? })
JSON.stringify(report)     // persistable receipts
```

Async candidates are detected automatically and awaited; they're marked
`(async)` in the printout because comparing an async function against a sync
one measures scheduler overhead too — cyclebench measures it honestly rather
than hiding it.

## Honest limitations

- This is a **comparator**, not a profiler: it tells you which candidate is
  faster and by how much, robustly; it does not tell you why (no hardware
  counters — use mitata or `perf` for that).
- Sub-nanosecond differences are below what any userland JS harness can
  resolve; cyclebench tells you so instead of printing three significant
  digits of noise.
- One runtime dependency, deliberately: `isoequal` (zero-dep itself) — deep
  result verification over arbitrary outputs, including cyclic structures
  and Sets/Maps, is a hard problem worth an entire library.

## License

MIT © Xyra Sinclair
