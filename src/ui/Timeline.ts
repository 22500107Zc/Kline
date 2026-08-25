import { Editor } from '../editor/Editor';
import { keyFrames } from '../anim/animation';
import { clear, h } from './dom';
import { icon } from './icons';

/**
 * The timeline strip.
 *
 * Keyframe diamonds come from the selected objects only — showing every key in
 * the scene at once turns the track into noise the moment more than a couple
 * of things are animated.
 */
export class Timeline {
  readonly root = h('div', { class: 'timeline' });
  private track = h('div', { class: 'tl-track' });
  private playhead = h('div', { class: 'tl-playhead' });
  private marks = h('div', { class: 'tl-marks' });
  private frameLabel = h('span', { class: 'tl-frame' });
  private controls = h('div', { class: 'tl-controls' });
  private ranges = h('div', { class: 'tl-ranges' });
  private scrubbing = false;

  constructor(private editor: Editor) {
    this.track.append(this.marks, this.playhead);
    this.root.append(this.controls, this.track, this.ranges);

    this.track.addEventListener('pointerdown', (e) => {
      this.scrubbing = true;
      this.track.setPointerCapture(e.pointerId);
      this.scrubTo(e.clientX);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this.scrubTo(e.clientX);
    });
    this.track.addEventListener('pointerup', (e) => {
      this.scrubbing = false;
      this.track.releasePointerCapture(e.pointerId);
    });

    editor.on('frame', () => this.refresh());
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private scrubTo(clientX: number): void {
    const rect = this.track.getBoundingClientRect();
    const tl = this.editor.scene.timeline;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    this.editor.setFrame(Math.round(tl.start + t * (tl.end - tl.start)));
  }

  private frameToPercent(frame: number): number {
    const tl = this.editor.scene.timeline;
    const span = Math.max(1, tl.end - tl.start);
    return ((frame - tl.start) / span) * 100;
  }

  refresh(): void {
    const ed = this.editor;
    const tl = ed.scene.timeline;

    clear(this.controls);
    const btn = (
      name: Parameters<typeof icon>[0], title: string, onClick: () => void, active = false,
    ): HTMLElement => h('button', {
      class: `tl-btn${active ? ' active' : ''}`, title, on: { click: onClick },
    }, [icon(name)]);

    this.controls.append(
      btn('skipStart', 'Jump to start (Shift+Left)', () => ed.setFrame(tl.start)),
      btn('stepBack', 'Previous frame (Left)', () => ed.stepFrame(-1)),
      btn(tl.playing ? 'pause' : 'play', 'Play / pause (Space)', () => ed.togglePlayback(), tl.playing),
      btn('stepForward', 'Next frame (Right)', () => ed.stepFrame(1)),
      btn('skipEnd', 'Jump to end (Shift+Right)', () => ed.setFrame(tl.end)),
      btn('key', 'Insert keyframe (I)', () => ed.insertKeyframe('all')),
      this.frameLabel,
    );
    this.frameLabel.textContent = `${tl.current}`;

    clear(this.ranges);
    const numeric = (
      label: string, value: number, onChange: (v: number) => void, min: number, max: number,
    ): HTMLElement => {
      const input = h('input', {
        class: 'tl-num', type: 'number', value: String(value),
        min: String(min), max: String(max),
      });
      input.addEventListener('change', () => {
        const v = Math.round(Number(input.value));
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return h('label', { class: 'tl-range' }, [h('span', { text: label }), input]);
    };
    this.ranges.append(
      numeric('Start', tl.start, (v) => {
        tl.start = Math.min(v, tl.end - 1);
        ed.emit('frame');
      }, 0, 100000),
      numeric('End', tl.end, (v) => {
        tl.end = Math.max(v, tl.start + 1);
        ed.emit('frame');
      }, 1, 100000),
      numeric('FPS', tl.fps, (v) => {
        tl.fps = Math.max(1, v);
        ed.emit('frame');
      }, 1, 240),
      h('button', {
        class: `tl-btn${tl.loop ? ' active' : ''}`, title: 'Loop playback',
        on: {
          click: () => {
            tl.loop = !tl.loop;
            ed.emit('frame');
          },
        },
      }, [icon('loop')]),
    );

    clear(this.marks);
    const frames = new Set<number>();
    for (const obj of ed.scene.selectedObjects()) for (const f of keyFrames(obj.animation)) frames.add(f);
    for (const f of frames) {
      if (f < tl.start || f > tl.end) continue;
      this.marks.appendChild(h('div', {
        class: `tl-key${f === tl.current ? ' current' : ''}`,
        title: `Frame ${f}`,
        style: { left: `${this.frameToPercent(f)}%` },
      }));
    }

    this.playhead.style.left = `${this.frameToPercent(tl.current)}%`;
    this.root.classList.toggle('has-animation', ed.scene.hasAnimation);
  }
}
