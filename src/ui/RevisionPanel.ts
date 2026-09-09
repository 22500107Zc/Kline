import { Editor } from '../editor/Editor';
import { MergeConflict, MergeReport } from '../build/merge';
import { button, h } from './dom';

/**
 * What a revision would do, before it does it.
 *
 * The viewport already shows the proposed shape — geometry is not reviewable
 * as a list — so this panel answers the questions the viewport cannot: which
 * of your edits were kept, which parts the generator left alone, what it could
 * not reconcile, and what it did not touch at all.
 *
 * Accept and Reject are the only ways out, and they are next to each other on
 * purpose. A preview that could be forgotten about would eventually be saved
 * by accident.
 */
export class RevisionPanel {
  readonly root = h('div', { class: 'revision-panel hidden' });
  private body = h('div', { class: 'revision-body' });
  private headline = h('div', { class: 'revision-headline' });

  constructor(private editor: Editor) {
    this.root.append(
      h('div', { class: 'overlay-head' }, [
        h('h2', { text: 'Review revision' }),
      ]),
      this.headline,
      this.body,
      h('div', { class: 'btn-row revision-actions' }, [
        button('Accept revision', () => this.editor.revision.accept(), {
          class: 'primary',
          title: 'Keep this version. One step in the undo history.',
        }),
        button('Reject revision', () => this.editor.revision.reject(), {
          title: 'Put everything back exactly as it was. Nothing is kept.',
        }),
      ]),
    );
    editor.on('revision', () => this.refresh());
  }

  private refresh(): void {
    const summary = this.editor.revision.summary;
    if (!summary) {
      this.root.classList.add('hidden');
      this.body.replaceChildren();
      // The headline as well: it names a revision that is over, and leaving it
      // behind would greet the next one with the last one's summary.
      this.headline.replaceChildren();
      return;
    }
    this.root.classList.remove('hidden');
    this.headline.replaceChildren(
      h('strong', { text: summary.label }),
      h('span', { class: 'dim', text: ` — ${summary.headline}` }),
    );

    const rows: (HTMLElement | null)[] = [];
    for (const note of summary.notes) {
      rows.push(h('p', { class: 'revision-note', text: note }));
    }
    rows.push(...this.conflictRows(summary.report.conflicts));
    rows.push(this.kept(summary.report));
    rows.push(this.changes(summary.report));
    this.body.replaceChildren(...rows.filter((r): r is HTMLElement => r !== null));
  }

  /**
   * A conflict, with the choices spelled out.
   *
   * Not a warning to click past: each one is a decision only the person who
   * did the work can make, so the wording says what disagrees and the buttons
   * say what each answer costs.
   */
  private conflictRows(conflicts: MergeConflict[]): HTMLElement[] {
    if (conflicts.length === 0) return [];
    const out: HTMLElement[] = [
      h('h3', { class: 'prop-heading', text: `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}` }),
      h('p', {
        class: 'dim small',
        text: 'These could not be merged, so nothing was applied to them — the version you '
          + 'had is what is in the scene. Choose per object, or reject the whole revision.',
      }),
    ];
    for (const conflict of conflicts) {
      out.push(h('div', { class: 'revision-conflict' }, [
        h('div', { class: 'revision-conflict-head' }, [
          h('strong', { text: conflict.name }),
          h('span', { class: 'revision-kind', text: conflict.kind }),
        ]),
        h('p', { class: 'small', text: conflict.detail }),
        h('div', { class: 'btn-row' }, [
          button('Keep mine', () => this.resolve(conflict, 'mine'), {
            title: 'Leave this object exactly as you had it. It is already what is in the scene.',
          }),
          button('Use the revised one', () => this.resolve(conflict, 'theirs'), {
            title: 'Replace this object with the generated version, losing your changes to it',
          }),
          button('Keep both', () => this.resolve(conflict, 'both'), {
            title: 'Keep yours and add the generated version beside it',
          }),
        ]),
      ]));
    }
    return out;
  }

  private resolve(conflict: MergeConflict, choice: 'mine' | 'theirs' | 'both'): void {
    const done = this.editor.revision.resolveConflict(conflict.key, choice);
    if (!done) this.editor.setStatus('That conflict could not be resolved — reject the revision and try again.');
  }

  /** What survived, which is the reassurance the whole feature exists to give. */
  private kept(report: MergeReport): HTMLElement | null {
    const kept = report.parts.filter((p) => p.keptYours.length);
    if (!kept.length && !report.userAdded.length && !report.protectedParts) return null;
    const lines: HTMLElement[] = [h('h3', { class: 'prop-heading', text: 'Kept as you had it' })];
    // Twenty rows reading "materials" is twenty rows of the same sentence.
    // Runs that were kept for the same reason collapse into one, so the row
    // that says something different — the step you moved, the one you
    // sculpted — is the one that stands out.
    for (const run of groupRuns(kept)) {
      lines.push(h('div', { class: 'revision-row' }, [
        h('span', { class: 'revision-name', text: run.label }),
        h('span', { class: 'dim', text: run.reason }),
      ]));
    }
    for (const own of report.userAdded) {
      lines.push(h('div', { class: 'revision-row' }, [
        h('span', { class: 'revision-name', text: own.name }),
        h('span', { class: 'dim', text: 'yours — not touched' }),
      ]));
    }
    return h('div', {}, lines);
  }

  private changes(report: MergeReport): HTMLElement | null {
    const changed = report.parts.filter((p) => p.action === 'added' || p.action === 'removed' || p.action === 'updated');
    if (!changed.length) return null;
    const lines: HTMLElement[] = [h('h3', { class: 'prop-heading', text: 'Changed by this revision' })];
    for (const part of changed.slice(0, 40)) {
      lines.push(h('div', { class: `revision-row revision-${part.action}` }, [
        h('span', { class: 'revision-action', text: part.action }),
        h('span', { class: 'revision-name', text: part.name }),
        part.tookGenerator.length
          ? h('span', { class: 'dim', text: part.tookGenerator.join(', ') })
          : null,
      ]));
    }
    if (changed.length > 40) lines.push(h('p', { class: 'dim small', text: `…and ${changed.length - 40} more.` }));
    return h('div', {}, lines);
  }
}

/** Consecutive parts kept for the same reason, as one line each. */
function groupRuns(
  parts: { name: string; keptYours: string[] }[],
): { label: string; reason: string }[] {
  const out: { label: string; reason: string }[] = [];
  let start = 0;
  const reasonOf = (i: number): string => parts[i].keptYours.join(', ');
  for (let i = 1; i <= parts.length; i++) {
    if (i < parts.length && reasonOf(i) === reasonOf(start)) continue;
    const run = i - start;
    out.push({
      label: run === 1
        ? parts[start].name
        : `${parts[start].name} – ${parts[i - 1].name} (${run})`,
      reason: reasonOf(start),
    });
    start = i;
  }
  return out;
}
