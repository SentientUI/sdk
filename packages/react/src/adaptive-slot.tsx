'use client';
import { useEffect, useMemo, useRef, type JSX, type ReactNode, type Ref } from 'react';
import { containsFormBlock, reveal, type RenderCaps, type SkeletonReport } from '@sentientui/core';
import { captureRegionSkeleton } from '@sentientui/core/region';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useSlotConfig } from './use-slot-config.js';
import { renderBlocks, renderCompose } from './blocks-render.js';
import { annotateSkeletonForReact, applyEdits, countTextLeaves, reactFingerprint, substituteSlotText } from './slot-text.js';
import {
  attachGoalListeners,
  goalLabelOf,
  goalValueOf,
  isDevBuild,
  normalizeGoal,
  trackExposure,
  type AdaptiveElement,
  type GoalConfig,
} from './adaptive-shared.js';
import { registerSlot } from './devtools-registry.js';
import { submitRegionRefresh, takeRegionRefresh } from './cell-preview.js';

// Warn once per slot id per page lifetime, not per render.
const warnedFormSlots = new Set<string>();
const warnedOpaqueSlots = new Set<string>();
const warnedBlockedSlots = new Set<string>();

export type AdaptiveSlotProps = {
  id: string;
  /** Baseline JSX — holdout, unknown personas, empty cells, every error path. */
  children: ReactNode;
  /** Hand-written versions (a hybrid <Adaptive>): each key is an arm the
   *  server may draw alongside your original and the generated versions, in
   *  one experiment (spec 2026-09-23 §7). */
  variants?: Record<string, ReactNode>;
  /** Receives form values when a generated form arm submits. Without it, form
   *  arms fall back to children entirely. Values never reach Sentient. */
  onFormSubmit?: (values: Record<string, string>) => void;
  /** Optional goal attached to the container (click/scroll/composite), same
   *  shape as AdaptiveGroup's. Form arms fire their own submitGoal regardless. */
  goal?: string | GoalConfig;
  className?: string;
  /** Wrapper element. @default 'div' */
  as?: AdaptiveElement;
  /** On first registration the SDK sends the region's rendered text (capped at
   *  400 chars) so dashboard-generated versions are grounded in what they
   *  replace. Set false for a slot wrapping personalized or account content —
   *  the text of THIS region is all that is ever read, never the page. */
  reportBaselineText?: boolean;
};

/**
 * @deprecated Use `<Adaptive id="…">{children}</Adaptive>` — `<Adaptive>`
 * without `variants` is this component. Kept exported because the package is
 * published; it will not be removed in a minor release.
 *
 * A region whose content the server may replace with a named arm — a copy
 * string or a validated Composition Block tree (registry slot config). The
 * children are the founder's baseline: they render untouched for holdout
 * traffic, unserved slots, and every error path, so the worst case is always
 * "nothing changed" (spec 2026-09-08 empty-cell-generation §3).
 */
const AUTHORED_PREFIX = 'authored.';

export function AdaptiveSlot({
  id,
  children,
  variants,
  onFormSubmit,
  goal,
  className,
  as: Tag = 'div',
  reportBaselineText = true,
}: AdaptiveSlotProps): JSX.Element {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  const nodeRef = useRef<HTMLElement | null>(null);
  // What this region can render (CONTRACTS §2), from the element tree so it
  // is known before any DOM exists. No reachable text → a fingerprint no real
  // skeleton has: no Rewrite arm can land here, so none may be drawn.
  const childFp = useMemo(() => reactFingerprint(children), [children]);
  // A hybrid declares its authored keys on every decide: the server draws
  // `authored.<key>` only for keys this page has, so a key removed in a deploy
  // simply leaves the arm space (and a sticky visitor re-decides).
  const authoredKey = variants ? Object.keys(variants).join('|') : '';
  const caps = useMemo<RenderCaps>(
    () => ({
      fp: childFp ?? '0000000000000000',
      forms: !!onFormSubmit,
      // This SDK renders Redesign trees (`like` + compose), so the server may
      // draw them for this page (CONTRACTS §2).
      compose: true,
      content: countTextLeaves(children) === 1,
      ...(authoredKey !== '' ? { authored: authoredKey.split('|'), children: true } : {}),
    }),
    [childFp, children, onFormSubmit, authoredKey],
  );
  // The region's skeleton, read from the DOM while it shows the developer's
  // children. Tied to the ELEMENT TREE by a parity check: edits are addressed
  // by leaf order, so if the tree and the DOM disagree the region is
  // unaddressable rather than edited in the wrong place.
  const captureSkeleton = (): SkeletonReport | null => {
    const el = nodeRef.current;
    if (!el || !reportBaselineText) return null;
    const cap = captureRegionSkeleton(el);
    if (!cap.skeleton) return { status: cap.reason };
    // A region wrapping a component (`<Adaptive><CtaButtons /></Adaptive>`, the
    // usual React shape) fails the parity check: the element tree can't see
    // text a component renders. It used to be reported unaddressable with no
    // skeleton at all, which blocked Redesign too — the Bodyshop CTA. The DOM
    // capture still describes the region, so send it marked non-editable:
    // Redesign replaces the whole region and needs no addressing, and this
    // page's fingerprint (childFp) never matches it, so no Rewrite arm can be
    // drawn here either way.
    return (
      annotateSkeletonForReact(cap.skeleton, children) ?? {
        ...cap.skeleton,
        editable: false,
        nodes: cap.skeleton.nodes.map((n) => ({ ...n, restylable: false })),
      }
    );
  };
  const { config, arm, palette, vocabulary, source } = useSlotConfig(id, {
    // Only ever read when the slot is unserved — at that moment the wrapper
    // contains exactly the baseline children this slot exists to replace.
    baselineText: reportBaselineText ? () => nodeRef.current?.textContent ?? null : undefined,
    render: () => caps,
    skeleton: captureSkeleton,
  });

  const tree = arm !== '' ? config?.blocks?.[arm] : undefined;
  // A Redesign arm: a composed section borrowing the site's own class lists.
  const composed = arm !== '' ? config?.compose?.[arm] : undefined;
  // A form tree without a handler is refused WHOLE (children render instead):
  // dropping just the form node would show a section minus its call-to-action —
  // looks live, converts nothing. Same rule the snippet applies.
  const formBlocked =
    ((tree !== undefined && containsFormBlock(tree)) || (composed !== undefined && containsFormBlock(composed.tree))) && !onFormSubmit;

  useEffect(() => {
    if (!formBlocked || !isDevBuild() || warnedFormSlots.has(id)) return;
    warnedFormSlots.add(id);
    console.warn(
      `[sentient] AdaptiveSlot "${id}" was served a form arm but has no onFormSubmit handler — ` +
        `rendering its baseline children instead. Pass onFormSubmit to render generated forms.`,
    );
  }, [formBlocked, id]);

  const fireFormGoal = (goalName: string): void => {
    if (!client || source === 'override') return;
    // componentGoal credits the optimizer (arm resolved from slot state);
    // goal() writes the session funnel record — the slot-goal shape
    // (use-adaptive-tokens). Field values are NOT on either write. A seeded
    // (not-yet-decided) arm keeps the session goal — the visitor did convert —
    // but not the arm credit: close-out would hand it to whichever arm this
    // session's decide draws afterwards.
    if (source !== 'seeded') client.componentGoal(id, goalName);
    client.goal(goalName, { metadata: { componentId: id, arm }, weight: 1.0, stepIndex: 0 });
  };

  // Precedence: served arm's block tree, else served content string, else the
  // developer's children. content/blocks are mutually exclusive on purpose —
  // the snippet's "content overwrites blocks' textContent" ordering hazard
  // (apply.ts) must not be reproduced here.
  let body: ReactNode = children;
  // True when the served arm never reaches the page: the form gate refused
  // its tree, renderBlocks returned root-level null (unknown ROOT node from a
  // newer server), or its copy had no text in children to land on. The
  // children shown then are a fallback,
  // not an assignment — the exposure gate below reads this so the arm is not
  // charged an impression it could never convert on.
  let armBlocked = false;
  const authoredArm = arm.startsWith(AUTHORED_PREFIX) ? arm.slice(AUTHORED_PREFIX.length) : null;
  if (config?.blocked === 'variant_history') {
    // Held back server-side: this id's trials live on the variant ledger until
    // the operator migrates it. Nothing was decided; nothing is exposed.
    armBlocked = true;
  } else if (authoredArm !== null) {
    // A served authored arm renders the developer's own JSX. The server only
    // draws keys this page declared, so a miss is an SSR/preload race — render
    // the original and don't expose.
    if (variants && Object.prototype.hasOwnProperty.call(variants, authoredArm)) body = variants[authoredArm];
    else armBlocked = true;
  } else if (composed !== undefined) {
    const rendered = formBlocked ? null : renderCompose(composed, { palette, vocabulary, onFormSubmit, onFormGoal: fireFormGoal });
    if (rendered === null) armBlocked = true;
    else body = rendered;
  } else if (tree !== undefined) {
    const rendered = formBlocked ? null : renderBlocks(tree, { palette, vocabulary, onFormSubmit, onFormGoal: fireFormGoal });
    if (rendered === null) armBlocked = true;
    else body = rendered;
  } else if (config?.edits !== undefined && source !== 'none') {
    // A Rewrite arm: new words (and swaps, hides, reorders) applied to the
    // developer's own elements. Written against a skeleton fingerprint; if the
    // children no longer match it, the edits would land on the wrong element.
    const e = config.edits;
    const placed = e.fp === childFp ? applyEdits(children, e.edits, e.leafToNode) : null;
    if (placed === null) armBlocked = true;
    else body = placed;
  } else if (config?.content !== undefined && source !== 'none') {
    // The copy goes INSIDE the developer's markup (slot-text.ts) — assigning
    // the string to body replaced a styled <button> with bare text.
    const placed = substituteSlotText(children, config.content);
    if (placed === null) armBlocked = true;
    else body = placed;
  }
  const textBlocked =
    armBlocked && tree === undefined && composed === undefined && config?.edits === undefined && authoredArm === null && config?.blocked === undefined;

  // Dev: say why a hybrid shows its original instead of experimenting.
  useEffect(() => {
    if (config?.blocked !== 'variant_history' || !isDevBuild() || warnedBlockedSlots.has(id)) return;
    warnedBlockedSlots.add(id);
    console.warn(
      `[sentient] <Adaptive id="${id}"> has results from its earlier variants experiment, so it is showing your ` +
        `original until you migrate it: Components → "${id}" → Migrate. Deploying code never switches an experiment.`,
    );
  }, [config?.blocked, id]);

  // What an authored arm rendered, for the dashboard's arm list and to ground
  // generation in the versions the team wrote (spec §7.4). Core dedupes per
  // (slot, key); the skeleton is parity-checked against that arm's JSX.
  const authoredOnScreen = authoredArm !== null && !armBlocked ? authoredArm : null;
  useEffect(() => {
    if (!authoredOnScreen || !reportBaselineText || !client) return;
    const el = nodeRef.current;
    if (!el) return;
    const cap = captureRegionSkeleton(el);
    const sk = cap.skeleton ? annotateSkeletonForReact(cap.skeleton, variants?.[authoredOnScreen]) : null;
    const text = el.textContent?.trim();
    client.reportSlots([], undefined, undefined, {
      [id]: [{ key: authoredOnScreen, ...(text ? { text } : {}), ...(sk ? { skeleton: sk } : {}) }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authoredOnScreen, client, id]);

  // A served Rewrite arm this page couldn't apply. The decide normally
  // excludes it up front (the page sends its fingerprint), so this fires for
  // SSR preloads, which have no DOM to fingerprint. Enough distinct visitors
  // reporting it suspend the stale skeleton's arms server-side. Previews
  // ('override') and snapshot seeds ('seeded') are not this session's draw.
  const editsDrift = armBlocked && config?.edits !== undefined && (source === 'preloaded' || source === 'client');
  useEffect(() => {
    if (!editsDrift || !config?.edits) return;
    // `client` in deps: it lands after the provider's init effect, and the
    // core dedupes per (slot, fingerprint), so a re-run never double-reports.
    client?.reportDrift?.(id, config.edits.fp, childFp, config.edits.fp === childFp ? 'unaddressable' : 'fp_mismatch');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editsDrift, id, childFp, client]);

  // A published slot the server has no skeleton for (registered before
  // skeletons existed): fill it from this page, once, while the DOM shows the
  // developer's children and not an arm's rendering of them.
  const showsChildren = body === children;
  useEffect(() => {
    if (!config?.needsSkeleton || !showsChildren) return;
    const sk = captureSkeleton();
    if (sk) client?.reportSkeleton?.(id, sk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.needsSkeleton, showsChildren, id, client]);

  // "Refresh from page" (operator, editor-token link): the trusted overwrite.
  // The preview module forced the original on screen; capture it here, where
  // the element-tree parity check can run, and post it.
  useEffect(() => {
    if (!showsChildren) return;
    const r = takeRegionRefresh(id);
    if (!r) return;
    const sk = captureSkeleton();
    submitRegionRefresh(r, sk && 'status' in sk ? { status: sk.status } : { skeleton: sk });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, showsChildren]);

  useEffect(() => {
    if (!textBlocked || !isDevBuild() || warnedOpaqueSlots.has(id)) return;
    warnedOpaqueSlots.add(id);
    console.warn(
      `[sentient] <Adaptive id="${id}"> was served a text version, but its children have several separate ` +
        `texts or none Sentient can reach — rendering the original instead. Regenerate the version (new ` +
        `versions edit each text in place), or put a single text inline.`,
    );
  }, [textBlocked, id]);

  // Devtools slot registry — arms come from the config's block map (the only
  // arm list the client can see for a registry slot). A slot is NOT a
  // component: registering it as one writes the wrong override channel.
  const armsKey = config?.blocks ? Object.keys(config.blocks).sort().join('|') : '';
  useEffect(() => {
    return registerSlot({ id, arms: armsKey === '' ? undefined : armsKey.split('|') });
  }, [id, armsKey]);

  // Exposure — once per (slot, arm). 'none' means the slot was never served
  // (children baseline): recording it would accrue a phantom impression that
  // can never convert. A forced arm ('override') is a preview, not an
  // exposure — same contract as useAdaptiveTokens. armBlocked is the same
  // phantom from the other direction: the arm was served but never rendered
  // (form gate, unknown root block, copy with nowhere to land), so an exposure here would let
  // the bandit permanently bury the arm on this install for a rendering
  // failure. No baseline exposure is reported either — decide didn't assign
  // baseline, the children are just the fail-safe. 'seeded' (last visit's
  // snapshot, not yet decided this session) renders for pre-paint parity but
  // has no slot_decisions row: exposing it trained an arm the server never
  // served this session, then exposed a second arm when the decide landed.
  const exposedArmRef = useRef<string | null>(null);
  useEffect(() => {
    if (!client || source === 'none' || source === 'seeded' || source === 'override' || arm === '' || armBlocked) return;
    if (exposedArmRef.current === arm) return;
    exposedArmRef.current = arm;
    trackExposure(client, apiKey, id, arm);
  }, [client, apiKey, id, arm, source, armBlocked]);

  // Optional container goal (click/scroll/composite) — slot-goal shape.
  //
  // Two writes, two different gates, because they answer different questions.
  //
  // `componentGoal` credits an ARM. It is suppressed whenever no arm earned
  // the conversion — nothing decided ('none'), decided-but-not-yet-confirmed
  // ('seeded'), or a served tree that never reached the page (armBlocked) —
  // because a goal stamped with the served arm would let close-out's
  // first-pass reconciliation (goal_achieved counts as an implied exposure,
  // CONTRACTS §2) re-mint the very phantom impression the exposure gate
  // suppressed, plus credit the arm for baseline's conversion.
  //
  // `goal` writes the SESSION funnel record, which is about the visitor, not
  // the arm. It fires whenever a real visitor converts. This effect used to
  // share the exposure gate and record NEITHER, which silently deleted the
  // conversion: measured on prod 2026-09-22 (Bodyshop Manchester), an
  // <Adaptive> switched from `variants` to generated mode registers a DRAFT
  // slot, sits at source 'none' until someone publishes a version, and its CTA
  // recorded nothing for five days while the funnel read 0%. `fireFormGoal`
  // above already makes exactly this split for a seeded arm; the container
  // goal disagreeing with it thirty lines away was the bug.
  //
  // 'override' is the one source that still records NOTHING: a forced arm is a
  // devtools/test preview, and a conversion nobody made must not reach either
  // write.
  //
  // When the arm is not creditable the session record carries NO arm either:
  // '' is the same shape an undecided slot already writes, and stamping the
  // arm the visitor never saw would re-introduce the attribution through the
  // metadata after the componentGoal write had been suppressed.
  const armCreditable = source !== 'none' && source !== 'seeded' && !armBlocked;
  const goalArm = armCreditable ? arm : '';
  const goalKey = goal === undefined ? null : typeof goal === 'string' ? goal : JSON.stringify(goal);
  useEffect(() => {
    if (!client || !goal || source === 'override') return;
    const node = nodeRef.current;
    if (!node) return;
    const label = goalLabelOf(goal);
    const declaredValue = goalValueOf(goal);
    let fired = false;
    return attachGoalListeners(
      node,
      normalizeGoal(goal),
      {
        fireGoal: () => {
          if (fired) return;
          fired = true;
          if (armCreditable) {
            if (declaredValue !== undefined) client.componentGoal(id, label, { value: declaredValue });
            else client.componentGoal(id, label);
          }
          client.goal(label, {
            metadata: { componentId: id, arm: goalArm },
            weight: 1.0,
            stepIndex: 0,
            ...(declaredValue !== undefined ? { value: declaredValue } : {}),
          });
        },
        fireStep: (name, weight, stepIndex) => {
          if (armCreditable) client.componentGoal(id, name, { reward: weight });
          client.goal(name, { metadata: { componentId: id, arm: goalArm }, weight, stepIndex });
        },
      },
      label,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id, goalKey, arm, source, armBlocked, armCreditable, goalArm]);

  // The adaptation reveal. Fires only when the ARM CHANGES after mount — an
  // SSR-rendered slot arrives with its arm already in the HTML, so the page was
  // always that way and animating it would be theatre on every page load. The
  // cases this does catch are the ones a visitor should notice: a client-side
  // decide resolving, and a persona upgrade re-deciding on a return visit.
  const revealedArm = useRef<string | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // First observation is the mounted state, whatever it is — record and stop.
    if (revealedArm.current === null) {
      revealedArm.current = arm;
      return;
    }
    if (revealedArm.current === arm) return;
    revealedArm.current = arm;
    // `previous` is deliberately omitted: React has already swapped the
    // children by the time this effect runs, so the pre-change text is gone and
    // the arm change is itself the evidence that something changed. The arm is
    // not passed either — `dataProps` already stamps `data-sentient-arm`, and
    // writing it twice would let the two drift.
    reveal(node);
  }, [arm]);

  const dataProps = useMemo(
    () => ({ 'data-sentient-slot': id, ...(arm !== '' ? { 'data-sentient-arm': arm } : {}) }),
    [id, arm],
  );

  return (
    <Tag ref={nodeRef as Ref<never>} className={className} {...dataProps}>
      {body}
    </Tag>
  );
}
