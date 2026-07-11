// The disagreement probe.
//
// A benchmark of functions that don't compute the same thing is not a
// benchmark — it's a race between a right answer and a wrong one. Most
// harnesses happily crown the wrong one (it is often faster precisely
// because it does less, or the wrong, work). cyclebench cross-validates
// every candidate's results before ranking.
//
//   node probes/disagreement.mjs
import { compare } from '../dist/index.js'

const input = Array.from({ length: 1000 }, (_, i) => ((i * 2654435761) % 4096) - 2048)

const candidates = {
    numericSort: (xs) => [...xs].sort((a, b) => a - b),
    defaultSort: (xs) => [...xs].sort(), // lexicographic on numbers — the classic bug
}

// --- Naive harness: times them, crowns one, never checks the outputs.
{
    const seq = (fn, ms) => {
        let calls = 0
        const t0 = performance.now()
        while (performance.now() - t0 < ms) {
            fn(input)
            calls++
        }
        return (performance.now() - t0) / calls
    }
    const a = seq(candidates.numericSort, 300)
    const b = seq(candidates.defaultSort, 300)
    console.log('naive harness:')
    console.log(`  numericSort ${(a * 1e3).toFixed(0)}µs/op`)
    console.log(`  defaultSort ${(b * 1e3).toFixed(0)}µs/op`)
    console.log(`  → crowns "${b < a ? 'defaultSort' : 'numericSort'}" and never mentions that`)
    console.log(`    defaultSort([-2048…]) puts "-1004" before "-2" — wrong answers, fast\n`)
}

// --- cyclebench: same race, but the results are compared first.
{
    const report = await compare({ candidates, inputs: [[input]], timeMs: 400 })
    console.log('cyclebench:')
    report.print()
    console.log(`\n  report.ok === ${report.ok} — refuse to ship a ranking built on wrong answers`)
}
