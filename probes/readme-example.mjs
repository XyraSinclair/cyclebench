// Regenerates the README's opening example with real numbers.
//   node probes/readme-example.mjs
import { compare } from '../dist/index.js'

const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
const arr = (n, r) => Array.from({ length: n }, () => (r() * n * 2) | 0)

const r = rng(42)
const small = arr(100, r)
const small2 = arr(100, r)
const big = arr(10_000, r)
const big2 = arr(10_000, r)

const report = await compare({
    candidates: {
        native: (a, b) => a.filter((x) => b.includes(x)),
        viaSet: (a, b) => {
            const s = new Set(b)
            return a.filter((x) => s.has(x))
        },
    },
    inputs: [
        [small, small2],
        [big, big2],
    ],
})
report.print({ perInput: true })
