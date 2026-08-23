import { Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { describePlan, executePlan } from '../build/plan';
import { interpret, knownSubjects } from '../build/interpreter';
import {
  LLMConfig, PROVIDER_DEFAULTS, ProviderKind, generatePlan, loadConfig, probeProvider, saveConfig,
} from '../build/llm';
import { button, clear, h, row, select } from './dom';

/**
 * Say what you want; get geometry.
 *
 * The built-in interpreter answers first because it is instant, offline and
 * free. A local model only gets asked when the interpreter does not recognise
 * the request — so the common cases never depend on anyone's server being up.
 */
export class BuildBar {
  readonly root = h('div', { class: 'build-bar' });

  private input = h('input', {
    class: 'build-input', type: 'text',
    placeholder: 'Build something — "a wooden table", "12 cubes in a circle", "a castle"',
  });
  private note = h('div', { class: 'build-note' });
  private settings = h('div', { class: 'build-settings hidden' });
  private statusChip = h('button', { class: 'build-chip', title: 'Local model settings' });
  private config: LLMConfig = loadConfig();
  private modelReady = false;
  private running: AbortController | null = null;
  private preferModel = false;

  constructor(private editor: Editor) {
    this.input.addEventListener('keydown', (e) => {
      // Typing must not reach the viewport keymap, but the app-wide chords
      // (Cmd+K, Cmd+B) still have to work from inside the field.
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
      if (e.key === 'Enter') void this.run();
      if (e.key === 'Escape') this.input.blur();
    });
    this.statusChip.addEventListener('click', () => {
      this.settings.classList.toggle('hidden');
      if (!this.settings.classList.contains('hidden')) this.buildSettings();
    });

    this.root.append(
      h('div', { class: 'build-row' }, [
        h('span', { class: 'build-mark', text: 'Build' }),
        this.input,
        button('Go', () => void this.run(), { class: 'primary build-go' }),
        this.statusChip,
      ]),
      this.note,
      this.settings,
    );
    this.setChip('offline recipes', 'idle');
    this.showHint();
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private showHint(): void {
    const subjects = knownSubjects();
    const sample = ['table', 'chair', 'house', 'tree', 'castle', 'robot', 'snowman', 'rocket'];
    this.note.textContent =
      `Knows ${subjects.length} things out of the box (${sample.join(', ')}…), plus "N shapes in a row / circle / stack / grid".`;
  }

  private setChip(text: string, state: 'ok' | 'bad' | 'idle' | 'busy'): void {
    this.statusChip.textContent = text;
    this.statusChip.className = `build-chip ${state}`;
  }

  // ------------------------------------------------------------------- build

  private async run(): Promise<void> {
    const prompt = this.input.value.trim();
    if (!prompt) return;
    if (this.running) {
      this.running.abort();
      return;
    }

    const offline = interpret(prompt);
    if (offline.plan && !this.preferModel) {
      this.apply(offline.plan, prompt);
      return;
    }

    if (this.modelReady) {
      await this.runModel(prompt, offline.plan ? () => this.apply(offline.plan!, prompt) : null);
      return;
    }

    if (offline.plan) {
      this.apply(offline.plan, prompt);
      return;
    }
    this.note.textContent = offline.reason ?? 'Could not build that.';
    this.editor.setStatus('Nothing built — no recipe matched and no model is connected');
  }

  private async runModel(prompt: string, fallback: (() => void) | null): Promise<void> {
    const controller = new AbortController();
    this.running = controller;
    this.setChip('thinking…', 'busy');
    this.note.textContent = `Asking ${this.config.model}…`;
    try {
      const result = await generatePlan(this.config, prompt, controller.signal);
      this.apply(result.plan, prompt, `${result.seconds.toFixed(1)}s`);
      if (result.warnings.length) {
        this.note.textContent += `  (${result.warnings.slice(0, 2).join(' ')})`;
      }
      this.setChip(this.config.model, 'ok');
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.setChip(this.config.model, aborted ? 'idle' : 'bad');
      if (fallback) {
        fallback();
        this.note.textContent += `  (the model failed, used a built-in recipe: ${(err as Error).message})`;
      } else {
        this.note.textContent = aborted ? 'Cancelled.' : (err as Error).message;
      }
    } finally {
      this.running = null;
    }
  }

  private apply(plan: ReturnType<typeof interpret>['plan'], prompt: string, timing?: string): void {
    if (!plan) return;
    this.editor.beginUndo(`Build ${plan.name}`);
    const origin = this.editor.scene.cursor.clone();
    const existing = this.editor.scene.bounds(false);
    // Drop new builds beside what is already there rather than inside it.
    if (existing.valid) origin.x = existing.max.x + 1;
    const { root } = executePlan(this.editor.scene, plan, new Vec3());
    root.position = origin;

    this.editor.selectObject(root.id);
    for (const id of this.editor.scene.objects.keys()) this.editor.renderer.invalidate(id);
    this.editor.emit('change');
    this.editor.frameSelected();

    const via = plan.source ? ` via ${plan.source}` : '';
    this.note.textContent = `${describePlan(plan)}${timing ? ` in ${timing}` : ''}${via}.`;
    this.editor.setStatus(`Built "${prompt}" — ${plan.parts.length} parts`);
  }

  // ---------------------------------------------------------------- settings

  private buildSettings(): void {
    clear(this.settings);
    this.settings.appendChild(h('h3', { class: 'prop-heading', text: 'Local model (optional)' }));
    this.settings.appendChild(h('p', { class: 'dim small' }, [
      h('span', { text: 'Everything above works with no model at all. Connect one and Kiln can build things it has no recipe for. ' }),
      h('b', { text: 'Ollama runs on this machine and is free forever' }),
      h('span', { text: ' — install it, then `ollama pull llama3.2`. An OpenAI-compatible endpoint works too, including free tiers.' }),
    ]));

    this.settings.appendChild(row('Provider', select(
      [{ value: 'ollama', label: 'Ollama (local, free)' }, { value: 'openai', label: 'OpenAI-compatible' }],
      this.config.provider,
      (v) => {
        const provider = v as ProviderKind;
        this.config = { provider, ...PROVIDER_DEFAULTS[provider] };
        saveConfig(this.config);
        this.modelReady = false;
        this.setChip('offline recipes', 'idle');
        this.buildSettings();
      },
    )));

    const textField = (
      label: string, value: string, placeholder: string, onChange: (v: string) => void,
      password = false,
    ): HTMLElement => {
      const input = h('input', {
        class: 'text-input', type: password ? 'password' : 'text', value, placeholder,
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        onChange(input.value.trim());
        saveConfig(this.config);
      });
      return row(label, input);
    };

    this.settings.appendChild(textField('Server', this.config.baseUrl, 'http://127.0.0.1:11434',
      (v) => { this.config.baseUrl = v || PROVIDER_DEFAULTS[this.config.provider].baseUrl; }));
    this.settings.appendChild(textField('Model', this.config.model, 'llama3.2',
      (v) => { this.config.model = v; }));
    if (this.config.provider === 'openai') {
      this.settings.appendChild(textField('API key', this.config.apiKey, 'only for hosted endpoints',
        (v) => { this.config.apiKey = v; }, true));
      this.settings.appendChild(h('p', { class: 'dim small', text: 'The key is kept in this browser only and sent to the endpoint you named, nowhere else.' }));
    }

    const preferBox = h('input', { type: 'checkbox', class: 'cb', checked: this.preferModel });
    preferBox.addEventListener('change', () => { this.preferModel = preferBox.checked; });
    this.settings.appendChild(h('label', { class: 'cb-row' }, [
      preferBox, h('span', { text: 'Always ask the model, even when a recipe exists' }),
    ]));

    this.settings.appendChild(h('div', { class: 'btn-row' }, [
      button('Connect', () => void this.checkModel()),
      button('Close', () => this.settings.classList.add('hidden')),
    ]));
    this.settings.appendChild(h('p', { class: 'dim small build-model-note' }));
  }

  private async checkModel(): Promise<void> {
    this.setChip('checking…', 'busy');
    const detail = this.settings.querySelector('.build-model-note');
    const result = await probeProvider(this.config);
    this.modelReady = result.ok;
    if (result.ok) {
      this.setChip(this.config.model, 'ok');
      const known = result.models.includes(this.config.model);
      if (detail) {
        detail.textContent = known || result.models.length === 0
          ? `Connected. ${result.detail}`
          : `Connected, but "${this.config.model}" is not installed. Available: ${result.models.slice(0, 6).join(', ')}`;
      }
      if (!known && result.models.length) this.modelReady = false;
    } else {
      this.setChip('no model', 'bad');
      if (detail) detail.textContent = result.detail;
    }
  }
}
