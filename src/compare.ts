import { isoEqual } from 'isoequal'
import { bandsOverlap, fmtNs, fmtOps, quartiles, round3, type Quartiles } from './stats.js'

export type AnyFn = (...args: any[]) => unknown

export type AgreeMode =
    | 'deep' // isoequal — cycles, Sets, Maps, sharing all handled
    | 'identity' // Object.is
    | false // outputs are incomparable by design (e.g. impure candidates)
    | ((a: unknown, b: unknown) => boolean)

export interface CompareSpec {
    /** The functions being raced. A record names them; an array uses fn.name. */
    candidates: Record<string, AnyFn> | readonly AnyFn[]
    /**
     * The argument suite — one entry per call shape, each an args array.
     * A benchmark over one input measures one point; a suite measures the
     * distribution you actually face. Defaults to a single zero-arg call.
     */
    inputs?: readonly (readonly unknown[])[]
    /** Measured time per candidate in ms (split evenly across inputs). Default 500. */
    timeMs?: number
    /** JIT warmup + slice calibration time per candidate in ms. Default 100. */
    warmupMs?: number
    /** Target duration of one interleaved slice in ms. Default 2. */
    targetSliceMs?: number
    /** How to check that all candidates computed the same thing. Default 'deep'. */
    agree?: AgreeMode
    /** Call (0,eval)('') between slices to discourage cross-slice over-specialization. Default false. */
    deopt?: boolean
}

export interface InputStats {
    /** Index into the spec's `inputs` (perInput can be sparse after an error). */
    inputIndex: number
    /** ns per call: median and quartile band across measured slices. */
    nsPerOp: number
    band: Quartiles
    calls: number
    measuredMs: number
}

export interface CandidateResult {
    name: string
    isAsync: boolean
    /** First error thrown, if any — an erroring candidate is reported, not ranked. */
    error?: unknown
    /** Equally-weighted mean of per-input medians (see DESIGN.md §aggregation). */
    nsPerOp: number
    opsPerSec: number
    band: Quartiles
    calls: number
    measuredMs: number
    perInput: InputStats[]
    /** ×fastest — 1 for the winner. */
    vsFastest: number
    /** Ranked adjacent and quartile bands overlap — do not read order as a verdict. */
    tiedWithNext: boolean
    /** In the majority agreement class for every input (null when agree: false or errored). */
    agrees: boolean | null
    /** Set when the measurement itself is untrustworthy (e.g. at the harness floor). */
    caveat?: string
}

export interface Disagreement {
    inputIndex: number
    /** Candidate names partitioned into equality classes; majority class first. */
    classes: string[][]
}

export interface Report {
    /** Ranked fastest-first; erroring candidates last. */
    candidates: CandidateResult[]
    inputCount: number
    /** ns/op of an empty function under this harness — the measurement floor. */
    floorNs: number
    disagreements: Disagreement[]
    /** True when every ranked candidate agreed on every input (or agree: false). */
    ok: boolean
    print(opts?: { perInput?: boolean }): void
    toJSON(): object
}

/* ------------------------------------------------------------------ */
/* Slice runners                                                       */
/* ------------------------------------------------------------------ */

// Results must escape or the JIT may delete the work being measured: every
// call's result is stored into a shared ring buffer that the report keeps
// alive. The runner is compiled per arity so the hot loop spreads args as
// a direct call — fn.apply with an args array costs more than many of the
// functions worth benchmarking.
type SliceRunner = (fn: AnyFn, args: readonly unknown[], sink: unknown[], k: number) => void

const runnerByArity = new Map<number, SliceRunner>()

function sliceRunner(arity: number): SliceRunner {
    let runner = runnerByArity.get(arity)
    if (runner) return runner
    try {
        const names: string[] = []
        let unpack = ''
        for (let i = 0; i < arity; i++) {
            names.push(`a${i}`)
            unpack += `var a${i}=args[${i}];`
        }
        runner = new Function(
            'fn',
            'args',
            'sink',
            'k',
            `${unpack}var m=0;for(var i=0;i<k;i++){sink[m=(m+1)&63]=fn(${names.join(',')})}`
        ) as SliceRunner
    } catch {
        // CSP without unsafe-eval: fall back to apply (higher floor, same semantics).
        runner = (fn, args, sink, k) => {
            let m = 0
            for (let i = 0; i < k; i++) sink[(m = (m + 1) & 63)] = fn.apply(undefined, args as unknown[])
        }
    }
    runnerByArity.set(arity, runner)
    return runner
}

async function runSliceAsync(
    fn: AnyFn,
    args: readonly unknown[],
    sink: unknown[],
    k: number
): Promise<void> {
    let m = 0
    for (let i = 0; i < k; i++) sink[(m = (m + 1) & 63)] = await fn.apply(undefined, args as unknown[])
}

/* ------------------------------------------------------------------ */
/* Cells: one (candidate × input) measurement                          */
/* ------------------------------------------------------------------ */

interface Cell {
    cand: Cand
    args: readonly unknown[]
    inputIndex: number
    run: SliceRunner
    /** Calls per slice, calibrated so a slice lasts ≈ targetSliceMs. */
    k: number
    samples: number[] // ns/op, one per measured slice
    calls: number
    measuredMs: number
    budgetMs: number
}

interface Cand {
    name: string
    fn: AnyFn
    isAsync: boolean
    error?: unknown
    agreementResults: unknown[] // one clean result per input
}

const sink: unknown[] = new Array(64).fill(undefined)
/** Read the sink so no engine can prove the stores dead. Exported for tests. */
export function _sinkProbe(): unknown {
    return sink[(Math.random() * 64) | 0]
}

function timeSlice(cell: Cell, k: number): number {
    const t0 = performance.now()
    cell.run(cell.cand.fn, cell.args, sink, k)
    return performance.now() - t0
}

async function timeSliceAsync(cell: Cell, k: number): Promise<number> {
    const t0 = performance.now()
    await runSliceAsync(cell.cand.fn, cell.args, sink, k)
    return performance.now() - t0
}

const MAX_K = 1 << 26

/** Grow k geometrically until one slice reaches the target duration. */
async function calibrate(cell: Cell, targetSliceMs: number, deadlineMs: number): Promise<void> {
    let k = 1
    for (;;) {
        const dt = cell.cand.isAsync ? await timeSliceAsync(cell, k) : timeSlice(cell, k)
        cell.measuredMs += dt // calibration counts toward warmup, not measurement
        if (dt >= targetSliceMs || k >= MAX_K || cell.measuredMs > deadlineMs) {
            cell.k = k
            return
        }
        // Aim 20% past the target so the final growth step clears it.
        k = dt < targetSliceMs / 64 ? k * 64 : Math.min(MAX_K, Math.ceil((k * targetSliceMs * 1.2) / dt))
    }
}

/* ------------------------------------------------------------------ */
/* The comparison                                                      */
/* ------------------------------------------------------------------ */

export async function compare(spec: CompareSpec): Promise<Report> {
    const {
        inputs = [[]],
        timeMs = 500,
        warmupMs = 100,
        targetSliceMs = 2,
        agree = 'deep',
        deopt = false,
    } = spec

    if (inputs.length === 0) throw new Error('cyclebench: inputs must not be empty')

    const entries: [string, AnyFn][] = Array.isArray(spec.candidates)
        ? spec.candidates.map((fn, i) => [fn.name || `fn${i}`, fn])
        : Object.entries(spec.candidates)
    if (entries.length === 0) throw new Error('cyclebench: no candidates')

    const eq: (a: unknown, b: unknown) => boolean =
        agree === 'deep' ? isoEqual : agree === 'identity' ? Object.is : agree || (() => true)

    // --- First clean pass: async detection, error capture, agreement results,
    // and mutation detection. A candidate that mutates its arguments would
    // corrupt every subsequent measurement (all cells share the input arrays),
    // so a comparison containing one is invalid and the run refuses to
    // continue. Snapshots are compared clone-to-clone, so structuredClone's
    // prototype-stripping cancels out; uncloneable inputs (functions, etc.)
    // skip the check.
    const snapshot = (): unknown => {
        try {
            return structuredClone(inputs)
        } catch {
            return undefined
        }
    }
    let beforeSnapshot = snapshot()
    // Inputs with volatile getters serialize differently on every read; two
    // honest snapshots differing means the check cannot distinguish
    // volatility from mutation — disable it rather than blame a candidate.
    if (beforeSnapshot !== undefined) {
        const second = snapshot()
        if (second === undefined || !isoEqual(beforeSnapshot, second)) beforeSnapshot = undefined
    }
    const cands: Cand[] = []
    for (const [name, fn] of entries) {
        const cand: Cand = { name, fn, isAsync: false, agreementResults: [] }
        try {
            for (const args of inputs) {
                let r: unknown = fn.apply(undefined, args as unknown[])
                if (r != null && typeof (r as PromiseLike<unknown>).then === 'function') {
                    cand.isAsync = true
                    r = await r
                }
                cand.agreementResults.push(r)
            }
        } catch (error) {
            cand.error = error
        }
        if (beforeSnapshot !== undefined) {
            // Cloneable before this candidate but not after (it inserted a
            // function, say) is itself proof of mutation — treat it as one
            // rather than letting the mutation disable its own detector.
            const afterSnapshot = snapshot()
            if (afterSnapshot === undefined || !isoEqual(beforeSnapshot, afterSnapshot))
                throw new Error(
                    `cyclebench: candidate "${name}" mutates its inputs — every ` +
                        `later measurement would run on corrupted data. Copy inside ` +
                        `the candidate (e.g. [...xs].sort(...)) instead.`
                )
            beforeSnapshot = afterSnapshot
        }
        cands.push(cand)
    }

    // --- Agreement: per input, partition candidates into equality classes.
    // NOTE: a custom `agree` predicate must be an equivalence relation;
    // tolerance predicates are not transitive and make the partition
    // insertion-order-dependent.
    const live = cands.filter((c) => !c.error)
    const disagreements: Disagreement[] = []
    const disagreeing = new Set<string>()
    if (agree !== false) {
        for (let i = 0; i < inputs.length; i++) {
            const classes: { rep: unknown; names: string[] }[] = []
            for (const cand of live) {
                const r = cand.agreementResults[i]
                const cls = classes.find((c) => eq(c.rep, r))
                if (cls) cls.names.push(cand.name)
                else classes.push({ rep: r, names: [cand.name] })
            }
            if (classes.length > 1) {
                classes.sort((a, b) => b.names.length - a.names.length)
                disagreements.push({ inputIndex: i, classes: classes.map((c) => c.names) })
                // A strict majority class is presumed right and only the rest
                // are flagged; when the top classes tie in size there is no
                // majority to bless — flag every class rather than letting
                // insertion order pick a winner.
                const tied = classes[0].names.length === classes[1].names.length
                for (const cls of tied ? classes : classes.slice(1))
                    for (const n of cls.names) disagreeing.add(n)
            }
        }
    }

    // --- Cells, warmup, calibration. (Warmup is sequential per cell — only
    // the measured run below interleaves; warmup time is never counted.)
    // A candidate that survived the clean pass but throws on a later call
    // is captured here the same way as in the measured loop: failure is
    // data, not a crash.
    const cells: Cell[] = []
    for (const cand of live)
        for (let i = 0; i < inputs.length; i++)
            cells.push(makeCell(cand, inputs[i], i, timeMs / inputs.length))
    const warmupPerCell = warmupMs / inputs.length
    for (const cell of cells) {
        if (cell.cand.error) continue
        try {
            await calibrate(cell, targetSliceMs, warmupPerCell)
            while (cell.measuredMs < warmupPerCell) {
                cell.measuredMs += cell.cand.isAsync
                    ? await timeSliceAsync(cell, cell.k)
                    : timeSlice(cell, cell.k)
            }
        } catch (error) {
            cell.cand.error = error
        }
        cell.measuredMs = 0 // warmup spent; measurement starts clean
    }

    // --- Harness floor, per arity, measured AFTER warmup so each arity's
    // call site is in the same inline-cache state the candidates face. A
    // floor taken through a virgin (monomorphic, inlined) runner understates
    // real overhead ~7×, which would let unmeasurably small candidates pass
    // uncaveated. Each used arity is first polymorphized with two distinct
    // empty functions, then timed with a third.
    // Polymorphization needs distinct function IDENTITIES at the call site,
    // not arity-matched formals (a plain call ignores extra args) — fresh
    // closures do the job with no code generation, so CSP/no-eval runtimes
    // keep working (the trampoline itself already falls back to apply).
    const freshEmpty = (): AnyFn => () => {}
    const floorByArity = new Map<number, number>()
    for (const arity of new Set(cells.map((c) => c.args.length))) {
        const dummyArgs = new Array(arity).fill(0)
        const run = sliceRunner(arity)
        for (let i = 0; i < 2; i++) run(freshEmpty(), dummyArgs, sink, 10_000)
        const floorCell = makeCell(
            { name: '', fn: freshEmpty(), isAsync: false, agreementResults: [] },
            dummyArgs,
            0,
            0
        )
        await calibrate(floorCell, targetSliceMs, 25)
        for (let spent = 0; spent < 25; ) {
            const dt = timeSlice(floorCell, floorCell.k)
            floorCell.samples.push((dt * 1e6) / floorCell.k)
            spent += dt
        }
        floorByArity.set(arity, quartiles(floorCell.samples).med)
    }
    const floorNs = Math.max(0, ...floorByArity.values())

    // --- The measured run: round-robin over every (candidate × input) cell.
    // Interleaving is the point — background load, thermal state, and GC
    // pressure drift on the scale of tens of milliseconds; slices of ~2ms
    // visited round-robin expose every candidate to the same weather.
    const pending = cells.filter((c) => !c.cand.error)
    for (let turn = 0; pending.length > 0; turn++) {
        const cell = pending[turn % pending.length]
        // eslint-disable-next-line no-eval
        if (deopt) (0, eval)('')
        let dt: number
        try {
            dt = cell.cand.isAsync ? await timeSliceAsync(cell, cell.k) : timeSlice(cell, cell.k)
        } catch (error) {
            cell.cand.error = error
            for (let i = pending.length - 1; i >= 0; i--)
                if (pending[i].cand === cell.cand) pending.splice(i, 1)
            continue
        }
        cell.samples.push((dt * 1e6) / cell.k)
        cell.calls += cell.k
        cell.measuredMs += dt
        // Interleaving must be fair in TIME, not turns: if a slice drifted
        // from the target (calibration ran on a colder JIT tier, or the
        // machine changed), rescale k so every cell keeps taking ~equal,
        // ~target-sized turns. This also stops budget overshoot.
        if (dt > targetSliceMs * 2 || dt < targetSliceMs * 0.5)
            cell.k = Math.max(1, Math.min(MAX_K, Math.round((cell.k * targetSliceMs) / Math.max(dt, 1e-6))))
        if (cell.measuredMs >= cell.budgetMs) pending.splice(pending.indexOf(cell), 1)
    }

    // A candidate can also mutate only on repeated calls (stateful); one
    // final snapshot catches that. The culprit is unknowable this late, but
    // a corrupted comparison must not ship.
    if (beforeSnapshot !== undefined) {
        const finalSnapshot = snapshot()
        if (finalSnapshot === undefined || !isoEqual(beforeSnapshot, finalSnapshot))
            throw new Error(
                'cyclebench: the inputs were mutated during measurement — some ' +
                    'candidate mutates on repeated calls; the comparison is invalid.'
            )
    }

    sink.fill(undefined) // don't retain candidate outputs after the run

    return buildReport(cands, cells, inputs.length, floorNs, floorByArity, disagreements, disagreeing, agree)
}

function makeCell(cand: Cand, args: readonly unknown[], inputIndex: number, budgetMs: number): Cell {
    return {
        cand,
        args,
        inputIndex,
        run: sliceRunner(args.length),
        k: 1,
        samples: [],
        calls: 0,
        measuredMs: 0,
        budgetMs,
    }
}

/* ------------------------------------------------------------------ */
/* Report assembly                                                     */
/* ------------------------------------------------------------------ */

function buildReport(
    cands: Cand[],
    cells: Cell[],
    inputCount: number,
    floorNs: number,
    floorByArity: Map<number, number>,
    disagreements: Disagreement[],
    disagreeing: Set<string>,
    agree: AgreeMode
): Report {
    const results: CandidateResult[] = cands.map((cand) => {
        const own = cells.filter((c) => c.cand === cand && c.samples.length > 0)
        const perInput: InputStats[] = own.map((c) => {
            const band = quartiles(c.samples)
            return {
                inputIndex: c.inputIndex,
                nsPerOp: band.med,
                band,
                calls: c.calls,
                measuredMs: c.measuredMs,
            }
        })
        // Equal weight per input: the suite defines the workload, the mean
        // preserves "total time across the suite" — see DESIGN.md.
        const mean = (f: (s: InputStats) => number) =>
            perInput.reduce((t, s) => t + f(s), 0) / (perInput.length || 1)
        const nsPerOp = cand.error && perInput.length === 0 ? NaN : mean((s) => s.nsPerOp)
        // Each cell answers to its own arity's floor (different arities have
        // genuinely different call overhead).
        let cellFloor = NaN
        const atFloor = own.some((c) => {
            const floor = floorByArity.get(c.args.length) ?? floorNs
            if (quartiles(c.samples).med < floor * 2) {
                cellFloor = floor
                return true
            }
            return false
        })
        return {
            name: cand.name,
            isAsync: cand.isAsync,
            error: cand.error,
            nsPerOp,
            opsPerSec: nsPerOp > 0 ? 1e9 / nsPerOp : NaN,
            band: { q1: mean((s) => s.band.q1), med: nsPerOp, q3: mean((s) => s.band.q3) },
            calls: perInput.reduce((t, s) => t + s.calls, 0),
            measuredMs: perInput.reduce((t, s) => t + s.measuredMs, 0),
            perInput,
            vsFastest: cand.error ? NaN : 1,
            tiedWithNext: false,
            agrees: cand.error || agree === false ? null : !disagreeing.has(cand.name),
            caveat:
                !cand.error && atFloor
                    ? `within 2× of the ${cellFloor.toFixed(2)}ns harness floor — call too small to compare reliably; give it bigger work`
                    : undefined,
        }
    })

    results.sort(
        (a, b) => Number(!!a.error) - Number(!!b.error) || a.nsPerOp - b.nsPerOp || 0
    )
    // Multipliers are ratios to the fastest MEASURABLE candidate — a ratio
    // to a floor-level number would be a ratio to harness noise. A caveated
    // candidate can still rank first (its row says "⚠ at floor").
    const fastest = results.find((r) => !r.error && !r.caveat) ?? results.find((r) => !r.error)
    for (const r of results) {
        if (!r.error && fastest) r.vsFastest = r.nsPerOp / fastest.nsPerOp
    }
    for (let i = 0; i + 1 < results.length; i++) {
        const a = results[i]
        const b = results[i + 1]
        if (!a.error && !b.error) a.tiedWithNext = bandsOverlap(a.band, b.band)
    }

    const ok =
        disagreements.length === 0 && results.every((r) => !r.error)

    return {
        candidates: results,
        inputCount,
        floorNs,
        disagreements,
        ok,
        print(opts) {
            printReport(this, opts)
        },
        toJSON() {
            const { candidates, inputCount, floorNs, disagreements, ok } = this
            const finite = (x: number) => (Number.isFinite(x) ? x : null)
            return {
                candidates: candidates.map((c) => ({
                    ...c,
                    nsPerOp: finite(c.nsPerOp),
                    opsPerSec: finite(c.opsPerSec),
                    vsFastest: finite(c.vsFastest),
                    error: c.error ? String(c.error) : undefined,
                })),
                inputCount,
                floorNs,
                disagreements,
                ok,
            }
        },
    }
}

function printReport(report: Report, opts: { perInput?: boolean } = {}): void {
    const rows = report.candidates.map((c) => {
        if (c.error) return [c.name, 'ERROR', String(c.error).slice(0, 60), '', '']
        const spread = c.band.med > 0 ? Math.round(((c.band.q3 - c.band.q1) / c.band.med) * 100) : 0
        return [
            c.name + (c.isAsync ? ' (async)' : ''),
            fmtNs(c.nsPerOp),
            `±${spread}%`,
            fmtOps(c.opsPerSec),
            c.caveat ? '⚠ at floor' : c.vsFastest === 1 ? 'fastest' : `${round3(c.vsFastest)}×`,
            c.agrees === false ? '✗ DISAGREES' : c.caveat ? `⚠ ${c.caveat}` : '',
        ]
    })
    const header = ['candidate', 'time/op', 'spread', 'ops/s', 'vs fastest', '']
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
    const line = (cols: string[]) => cols.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ')
    console.log(line(header))
    console.log(widths.map((w) => '─'.repeat(w)).join('──'))
    for (let i = 0; i < rows.length; i++) {
        console.log(line(rows[i]))
        if (report.candidates[i].tiedWithNext && !report.candidates[i].error)
            console.log(`${' '.repeat(widths[0])}  ┄ statistical tie with next ┄`)
    }
    console.log(
        `harness floor ${fmtNs(report.floorNs)}/op · ${report.inputCount} input${report.inputCount === 1 ? '' : 's'}` +
            (report.ok ? ' · results agree' : '')
    )
    for (const d of report.disagreements) {
        console.log(
            `DISAGREEMENT on input ${d.inputIndex}: ` +
                d.classes.map((names) => `{${names.join(', ')}}`).join(' vs ')
        )
    }
    if (opts.perInput && report.inputCount > 1) {
        for (const c of report.candidates) {
            if (c.error) continue
            console.log(
                `${c.name}: ` + c.perInput.map((s, i) => `[${i}] ${fmtNs(s.nsPerOp)}`).join('  ')
            )
        }
    }
}
