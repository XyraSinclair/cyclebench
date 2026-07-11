/** Order statistics over slice samples. Small n (tens to hundreds); clarity wins. */

export interface Quartiles {
    q1: number
    med: number
    q3: number
}

/** Linear-interpolation quartiles of an unsorted sample. n must be ≥ 1. */
export function quartiles(sample: readonly number[]): Quartiles {
    const xs = Array.from(sample).sort((a, b) => a - b)
    return { q1: at(xs, 0.25), med: at(xs, 0.5), q3: at(xs, 0.75) }
}

function at(sorted: readonly number[], p: number): number {
    const pos = (sorted.length - 1) * p
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Two measurements are a statistical tie when their interquartile bands
 * overlap — we refuse to rank inside the noise.
 */
export function bandsOverlap(a: Quartiles, b: Quartiles): boolean {
    return a.q1 <= b.q3 && b.q1 <= a.q3
}

export function round3(x: number): number {
    if (!isFinite(x) || x === 0) return x
    const mag = 10 ** (2 - Math.floor(Math.log10(Math.abs(x))))
    return Math.round(x * mag) / mag
}

/** 12.3ns · 4.56µs · 7.89ms — the unit that keeps 1–3 integer digits. */
export function fmtNs(ns: number): string {
    if (ns >= 1e6) return `${round3(ns / 1e6)}ms`
    if (ns >= 1e3) return `${round3(ns / 1e3)}µs`
    return `${round3(ns)}ns`
}

export function fmtOps(opsPerSec: number): string {
    if (opsPerSec >= 1e9) return `${round3(opsPerSec / 1e9)}G/s`
    if (opsPerSec >= 1e6) return `${round3(opsPerSec / 1e6)}M/s`
    if (opsPerSec >= 1e3) return `${round3(opsPerSec / 1e3)}k/s`
    return `${round3(opsPerSec)}/s`
}
