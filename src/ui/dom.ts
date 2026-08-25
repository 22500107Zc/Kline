/** Tiny DOM helpers — the UI is plain DOM, no framework, no runtime deps. */

type Child = Node | string | null | undefined | false;

export interface ElementProps {
  class?: string;
  title?: string;
  text?: string;
  html?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  step?: string;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: ElementProps = {}, children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.title) node.title = props.title;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.type && 'type' in node) (node as HTMLInputElement).type = props.type;
  if (props.value !== undefined && 'value' in node) (node as HTMLInputElement).value = props.value;
  if (props.placeholder && 'placeholder' in node) (node as HTMLInputElement).placeholder = props.placeholder;
  if (props.checked !== undefined && 'checked' in node) (node as HTMLInputElement).checked = props.checked;
  if (props.disabled !== undefined && 'disabled' in node) (node as HTMLButtonElement).disabled = props.disabled;
  if (props.min !== undefined && 'min' in node) (node as HTMLInputElement).min = props.min;
  if (props.max !== undefined && 'max' in node) (node as HTMLInputElement).max = props.max;
  if (props.step !== undefined && 'step' in node) (node as HTMLInputElement).step = props.step;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.style) Object.assign(node.style, props.style);
  if (props.on) {
    for (const [name, fn] of Object.entries(props.on)) {
      node.addEventListener(name, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export interface NumberFieldOptions {
  label: string;
  value: number;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
  /** Colour key for X/Y/Z component fields. */
  axis?: 'x' | 'y' | 'z';
  onChange: (value: number) => void;
  /** Called continuously while dragging, if different from onChange. */
  onLive?: (value: number) => void;
}

/**
 * A value field you can drag to scrub or click to type — the interaction every
 * DCC app has and every web form lacks.
 */
export function numberField(opts: NumberFieldOptions): HTMLElement {
  const step = opts.step ?? 0.01;
  const precision = opts.precision ?? 3;
  const format = (v: number): string => {
    const s = v.toFixed(precision);
    return s.replace(/\.?0+$/, '') || '0';
  };

  const input = h('input', { class: 'nf-input', value: format(opts.value), type: 'text' });
  const field = h('div', { class: `nf${opts.axis ? ` nf-${opts.axis}` : ''}` }, [
    h('span', { class: 'nf-label', text: opts.label }),
    input,
  ]);

  let dragging = false;
  let startX = 0;
  let startValue = opts.value;
  let moved = false;

  const clampValue = (v: number): number => {
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    return v;
  };

  const commit = (v: number, live: boolean): void => {
    const clamped = clampValue(v);
    input.value = format(clamped);
    if (live && opts.onLive) opts.onLive(clamped);
    else opts.onChange(clamped);
  };

  field.addEventListener('pointerdown', (e) => {
    if (e.target === input && input.classList.contains('editing')) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startValue = parseFloat(input.value) || 0;
    field.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  field.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 2) moved = true;
    if (!moved) return;
    field.classList.add('scrubbing');
    const scale = e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1;
    commit(startValue + dx * step * scale, true);
  });
  field.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    field.classList.remove('scrubbing');
    field.releasePointerCapture(e.pointerId);
    if (moved) commit(parseFloat(input.value) || 0, false);
    else {
      input.classList.add('editing');
      input.focus();
      input.select();
    }
  });

  const finishTyping = (): void => {
    input.classList.remove('editing');
    const parsed = parseFloat(input.value);
    commit(Number.isFinite(parsed) ? parsed : startValue, false);
  };
  input.addEventListener('blur', finishTyping);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = format(startValue);
      input.blur();
    }
  });

  return field;
}

export function row(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'prop-row' }, [h('label', { class: 'prop-label', text: label }), control]);
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value, class: 'cb' });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'cb-row' }, [input, h('span', { text: label })]);
}

export function select(
  options: { value: string; label: string }[], value: string, onChange: (v: string) => void,
): HTMLSelectElement {
  const el = h('select', { class: 'sel' },
    options.map((o) => h('option', { value: o.value, text: o.label })));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function button(
  label: string, onClick: () => void, opts: { class?: string; title?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  return h('button', {
    class: `btn${opts.class ? ` ${opts.class}` : ''}`,
    text: label,
    title: opts.title ?? label,
    disabled: opts.disabled,
    on: { click: onClick },
  });
}
