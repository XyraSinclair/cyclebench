import { describe, expect, it } from 'vitest'
import { compare } from './compare.js'
import { fmtNs, fmtOps, quartiles, round3 } from './stats.js'

// Small budgets keep the suite fast; every assertion tolerates timer noise.
const FAST = { timeMs: 60, warmupMs: 20 }

function work(n: number): number {
    let acc = 0
    for (let i = 0; i < n; i++) acc += Math.sqrt(i)
    return acc
}

describe('ranking', () => {
    it('orders a 50× workload gap correctly with sane numbers', async () => {
        const report = await compare({
            candidates: {
                // Same verdict, 50× the work: sum forward vs sum forward 50 times.
                light: (n: number) => work(n),
                heavy: (n: number) => {
                    let r = 0
                    for (let i = 0; i < 50; i++) r = work(n)
                    return r
                },
            },
            inputs: [[200]],
            ...FAST,
        })
        expect(report.candidates.map((c) => c.name)).toEqual(['light', 'heavy'])
        const [light, heavy] = report.candidates
        expect(light.vsFastest).toBe(1)
        expect(heavy.vsFastest).toBeGreaterThan(5)
        expect(light.calls).toBeGreaterThan(100)
        expect(light.nsPerOp).toBeGreaterThan(0)
        expect(light.opsPerSec).toBeGreaterThan(0)
        expect(report.ok).toBe(true) // identical results, so agreement passes
    })

    it('near-identical candidates land close and usually tie', async () => {
        const f = (n: number) => work(n)
        const report = await compare({
            candidates: { a: f, b: (n: number) => work(n) },
            inputs: [[3000]],
            ...FAST,
        })
        const [first, second] = report.candidates
        expect(second.vsFastest).toBeLessThan(1.25)
        expect(first.agrees).toBe(true)
        expect(second.agrees).toBe(true)
    })
})

describe('agreement', () => {
    it('flags the minority candidate that computes the wrong thing', async () => {
        const report = await compare({
            candidates: {
                sortA: (xs: number[]) => [...xs].sort((a, b) => a - b),
                sortB: (xs: number[]) => [...xs].sort((a, b) => a - b),
                lexicographic: (xs: number[]) => [...xs].sort(), // the classic bug
            },
            inputs: [[[10, 9, 8, 100, 1]]],
            ...FAST,
        })
        expect(report.ok).toBe(false)
        expect(report.disagreements).toHaveLength(1)
        expect(report.disagreements[0].classes[0].sort()).toEqual(['sortA', 'sortB'])
        expect(report.disagreements[0].classes[1]).toEqual(['lexicographic'])
        const wrong = report.candidates.find((c) => c.name === 'lexicographic')!
        expect(wrong.agrees).toBe(false)
    })

    it('deep agreement sees through Sets in different insertion orders', async () => {
        const report = await compare({
            candidates: {
                forward: () => new Set([{ a: 1 }, { b: 2 }]),
                backward: () => new Set([{ b: 2 }, { a: 1 }]),
            },
            ...FAST,
        })
        expect(report.ok).toBe(true)
    })

    it('identity mode distinguishes what deep mode equates', async () => {
        const report = await compare({
            candidates: { x: () => ({ v: 1 }), y: () => ({ v: 1 }) },
            agree: 'identity',
            ...FAST,
        })
        expect(report.ok).toBe(false)
    })

    it('agree: false disables checking and reports agrees: null', async () => {
        const report = await compare({
            candidates: { r1: () => Math.random(), r2: () => Math.random() },
            agree: false,
            ...FAST,
        })
        expect(report.ok).toBe(true)
        expect(report.candidates.every((c) => c.agrees === null)).toBe(true)
    })

    it('custom agree functions are honored', async () => {
        const report = await compare({
            candidates: { a: () => 1.0, b: () => 1.0000001 },
            agree: (x, y) => Math.abs((x as number) - (y as number)) < 1e-3,
            ...FAST,
        })
        expect(report.ok).toBe(true)
    })
})

describe('failure and floor', () => {
    it('an erroring candidate is reported last, not ranked, and does not poison the run', async () => {
        const report = await compare({
            candidates: {
                fine: () => work(500),
                broken: () => {
                    throw new Error('boom')
                },
            },
            ...FAST,
        })
        expect(report.candidates.at(-1)!.name).toBe('broken')
        expect(String(report.candidates.at(-1)!.error)).toContain('boom')
        expect(report.candidates[0].calls).toBeGreaterThan(0)
        expect(report.ok).toBe(false)
    })

    it('flags calls too small to measure against the harness floor', async () => {
        const report = await compare({
            candidates: { tiny: (a: number, b: number) => a + b, alsoTiny: (a: number, b: number) => b + a },
            inputs: [[1, 2]],
            ...FAST,
        })
        expect(report.floorNs).toBeGreaterThan(0)
        expect(report.candidates.some((c) => c.caveat)).toBe(true)
    })
})

describe('inputs as a suite', () => {
    it('produces per-input stats and equally-weighted aggregation', async () => {
        const report = await compare({
            candidates: { sqrtSum: (n: number) => work(n) },
            inputs: [[100], [5000]],
            ...FAST,
        })
        const c = report.candidates[0]
        expect(c.perInput).toHaveLength(2)
        expect(c.perInput[1].nsPerOp).toBeGreaterThan(c.perInput[0].nsPerOp)
        const mean = (c.perInput[0].nsPerOp + c.perInput[1].nsPerOp) / 2
        expect(c.nsPerOp).toBeCloseTo(mean, 6)
    })

    it('rejects an empty input suite', async () => {
        await expect(compare({ candidates: { f: () => 1 }, inputs: [] })).rejects.toThrow()
    })

    it('refuses to run a candidate that mutates its inputs', async () => {
        await expect(
            compare({
                candidates: {
                    copying: (xs: number[]) => [...xs].sort((a, b) => a - b),
                    inPlace: (xs: number[]) => xs.sort((a, b) => a - b),
                },
                inputs: [[[3, 1, 2]]],
                ...FAST,
            })
        ).rejects.toThrow(/inPlace.*mutates/)
    })

    it('mutation detection skips uncloneable inputs rather than failing', async () => {
        const report = await compare({
            candidates: { call: (f: () => number) => f() },
            inputs: [[() => 42]],
            ...FAST,
        })
        expect(report.candidates[0].calls).toBeGreaterThan(0)
    })
})

describe('async', () => {
    it('detects and measures async candidates', async () => {
        const report = await compare({
            candidates: {
                sync: () => work(300),
                queued: async () => work(300),
            },
            ...FAST,
        })
        const queued = report.candidates.find((c) => c.name === 'queued')!
        expect(queued.isAsync).toBe(true)
        expect(queued.calls).toBeGreaterThan(0)
        expect(report.ok).toBe(true)
    })
})

describe('report surface', () => {
    it('toJSON round-trips through JSON.stringify', async () => {
        const report = await compare({ candidates: { f: () => work(200) }, ...FAST })
        const parsed = JSON.parse(JSON.stringify(report))
        expect(parsed.candidates[0].name).toBe('f')
        expect(parsed.floorNs).toBeGreaterThan(0)
    })

    it('print() writes a table without throwing', async () => {
        const report = await compare({
            candidates: { a: () => work(200), b: () => work(2000) },
            inputs: [[1], [2]],
            ...FAST,
        })
        report.print({ perInput: true })
    })
})

describe('stats', () => {
    it('quartiles interpolate', () => {
        expect(quartiles([1, 2, 3, 4]).med).toBe(2.5)
        expect(quartiles([5]).med).toBe(5)
        expect(quartiles([1, 100]).q1).toBeCloseTo(25.75)
    })
    it('formatting picks sensible units', () => {
        expect(fmtNs(12.34)).toBe('12.3ns')
        expect(fmtNs(4560)).toBe('4.56µs')
        expect(fmtNs(7.89e6)).toBe('7.89ms')
        expect(fmtOps(1.23e6)).toBe('1.23M/s')
        expect(round3(0.0012345)).toBeCloseTo(0.00123)
    })
})
