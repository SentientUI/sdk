# @sentientui/policy

Pure decision-policy functions shared by the SentientUI API and the keyless local
engine. This package is the single source of truth for *how a decision is made* —
Thompson sampling, empirical-Bayes pooling/shrinkage, arm encoding, slot
validation, and layout selection — so the server and the on-device engine always
agree.

Everything here is a **pure function**: no I/O, no global state, no side effects.
Randomized functions take an injectable `rand: () => number` (uniform `[0,1)`) so
results are fully reproducible when you pass a seeded PRNG. The default is
`Math.random`, which is **non-deterministic** — pass a seed for tests or
replayable decisions.

## What's inside

**Bandit / Thompson sampling** (`bandit.ts`)
- `sampleBeta(alpha, beta, rand?)` — one draw from `Beta(alpha, beta)` (Marsaglia–Tsang gamma method).
- `sampleArm(arms, rand?)` — Thompson-samples each arm's Beta posterior and returns the argmax arm id (or `null` for no arms).

**Empirical-Bayes pooling & shrinkage** (`shrinkage.ts`, `pooling.ts`)
- `shrunkPosterior(persona, pooled, m?)` — one-axis read-time shrinkage; cells are born warm (`w = m / (m + exposures)`) and detach as their own data accumulates. `SHRINKAGE_M` is the default strength.
- `posteriorOfCounts({ exposures, conversions })` — `Beta` posterior from raw counts (`alpha = conversions + 1`, `beta = max(0, exposures − conversions) + 1`).
- `pooledPosterior(cells, personaKnown, m?)` — hierarchical partial pooling over `(segment, persona)`; reproduces legacy segment-only and persona-only behavior when only those cells are present. `POOL_ALL` is the `__all__` sentinel for marginal/global rows.
- `weightCellsFor(...)` — the write-side counterpart: which weight rows a single trial/credit must bump.

**Arm encoding & slot validation** (`arm-encoding.ts`)
- `canonicalArm(values)` / `parseArm(arm)` — stable string encoding of a multi-dimensional arm and its inverse.
- `marginalArmKey(dim, value)`, `slotBaselineArm(decl)`, `slotResultFor(decl, arm)` — arm helpers for a slot declaration.
- `validateSlotDecl(decl)` — structural validation of a `SlotDecl`, returning `{ ok: true }` or `{ ok: false, reason }`.

**Layout selection** (`layout-heuristics.ts`, `choose-layout.ts`, `hash.ts`)
- `candidateLayouts(sections, sectionTypes, sectionRoles?)` — the candidate orderings for a PAGE: the authored order plus each archetype's. Takes no persona — the persona selects posteriors, not which layouts are reachable.
- `LAYOUT_ARCHETYPES` / `orderByArchetype(sections, sectionTypes, archetype, sectionRoles?)` — a catalogue of orderings (`conversion_led`, `evidence_led`, `price_led`, `discovery_led`). Not a persona taxonomy.
- `previewOrderForPersona(sections, sectionTypes, persona, sectionRoles?)` — **keyless local mode only.** Maps any persona key onto an archetype so `?sentient_persona=<anything>` visibly rearranges a page with no server. Never use it for serving.
- `chooseLayout(sections, sectionTypes, persona, learned, rand?)` — Thompson-samples the learned layout posteriors over the candidates. The authored order is always among them, so "leave the page alone" can win.
- *Deprecated:* `applyClusterHeuristic` (use `orderByArchetype` on the server, `previewOrderForPersona` locally).
- `hashLayout(order)` — stable hash of a section order (the `layoutHash` key).

**Personas** (`personas.ts`)
- `UNKNOWN_PERSONA`, `UNKNOWN_PERSONA_DISPLAY` — the only persona key the package defines. There is no built-in persona list: every persona comes from the project's own vocabulary (declared by the app, or promoted by discovery).
- `canonicalPersona(label)` — normalize any label to a persona key (trimmed, lowercased, key-shaped), or `'unknown'`. Says nothing about vocabulary membership.

**Deterministic helpers** (`deterministic.ts`)
- `fnv1a(input)` — FNV-1a hash.
- `pickDeterministicArm(sessionId, slotId, arms)` — hash-based, seed-free arm pick (stable per session/slot).
- `confidenceBand(c)` — map a `[0,1]` confidence to `'low' | 'medium' | 'high'`.

## Usage

```ts
import { sampleArm, posteriorOfCounts } from '@sentientui/policy';

// Thompson-sample the arm to serve from each arm's Beta posterior.
const arms = [
  { arm: 'control', ...posteriorOfCounts({ exposures: 200, conversions: 20 }) },
  { arm: 'variant_b', ...posteriorOfCounts({ exposures: 180, conversions: 27 }) },
];

const chosen = sampleArm(arms); // e.g. 'variant_b' — uses Math.random

// Pass a seeded PRNG for reproducible selection (tests, replayable decisions):
const chosenSeeded = sampleArm(arms, mySeededRng);
```

```ts
import { chooseLayout, hashLayout, type LearnedLayout } from '@sentientui/policy';

const learned = new Map<string, LearnedLayout>(); // from your layout_weights store
const order = chooseLayout(sections, sectionTypes, 'evaluator', learned); // a key from the project's own vocabulary
const key = hashLayout(order);
```

## License

MIT
