// The measurement-floor probe.
//
// Below a few nanoseconds per call, a harness is no longer measuring your
// function — it is measuring itself (and whatever the JIT decided to delete).
// Naive harnesses print confident rankings down there; cyclebench measures
// its own floor with an empty function and flags anything within 2× of it.
//
//   node probes/dce.mjs
import { compare } from '../dist/index.js'

const add = (a, b) => a + b
const addReversed = (a, b) => b + a

// --- Naive harness: happily reports that one one-liner beats the other.
{
    const seq = (fn, n) => {
        const t0 = performance.now()
        let acc = 0
        for (let i = 0; i < n; i++) acc += fn(1, 2)
        const dt = performance.now() - t0
        return { nsPerOp: (dt * 1e6) / n, acc }
    }
    const a = seq(add, 20_000_000)
    const b = seq(addReversed, 20_000_000)
    console.log('naive harness:')
    console.log(`  add         ${a.nsPerOp.toFixed(2)}ns/op`)
    console.log(`  addReversed ${b.nsPerOp.toFixed(2)}ns/op`)
    const diff = Math.abs(1 - a.nsPerOp / b.nsPerOp) * 100
    console.log(`  → declares a ${diff.toFixed(0)}% winner between two identical additions\n`)
}

// --- cyclebench: measures the floor first, then refuses to pretend.
{
    const report = await compare({
        candidates: { add, addReversed },
        inputs: [[1, 2]],
        timeMs: 300,
    })
    console.log('cyclebench:')
    report.print()
}
