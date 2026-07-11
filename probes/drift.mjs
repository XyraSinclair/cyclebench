// The drift probe — the reason cyclebench exists.
//
// A machine's speed is weather: background processes, thermal throttling,
// GC pressure. A sequential harness (bench A fully, then B) integrates each
// candidate over DIFFERENT weather. This probe makes the weather explicit
// and deterministic: the workload's cost doubles at a known wall-clock
// moment, simulating a machine that gets busy halfway through your run.
// The two candidates are THE SAME FUNCTION. A fair harness must call a tie.
//
//   node probes/drift.mjs
import { compare } from '../dist/index.js'

function work(n) {
    let acc = 0
    for (let i = 0; i < n; i++) acc += Math.sqrt(i)
    return acc
}

// Cost multiplier steps 1 → 2 at `halfMs` after t0. Deterministic drift.
function makeWeather(halfMs) {
    const t0 = performance.now()
    return () => (performance.now() - t0 > halfMs ? 2 : 1)
}

const BASE = 2_000

console.log('Two IDENTICAL candidates. The machine "gets busy" halfway through.\n')

// --- Sequential harness (how most benchmarks work): A fully, then B.
{
    const weather = makeWeather(500)
    const candidate = () => work(BASE * weather())
    const seq = (fn, ms) => {
        let calls = 0
        const t0 = performance.now()
        while (performance.now() - t0 < ms) {
            fn()
            calls++
        }
        return (performance.now() - t0) / calls
    }
    const a = seq(candidate, 500) // runs entirely in quiet weather
    const b = seq(candidate, 500) // runs entirely in busy weather
    console.log('sequential harness:')
    console.log(`  first  ${(a * 1e3).toFixed(1)}µs/op`)
    console.log(`  second ${(b * 1e3).toFixed(1)}µs/op   → "${(b / a).toFixed(2)}× slower" — a lie\n`)
}

// --- cyclebench: interleaved ~2ms slices see the same weather.
{
    const weather = makeWeather(650) // mid-measurement (after floor+warmup ≈ 150ms)
    const report = await compare({
        candidates: {
            first: () => work(BASE * weather()),
            second: () => work(BASE * weather()),
        },
        agree: false, // outputs depend on the weather at call time
        timeMs: 500,
        warmupMs: 60,
    })
    console.log('cyclebench (interleaved):')
    report.print()
    const [x, y] = report.candidates
    console.log(
        `\n  verdict: ${y.vsFastest.toFixed(2)}× apart${x.tiedWithNext ? ' (statistical tie)' : ''} — the truth`
    )
}
