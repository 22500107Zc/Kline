import { Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { describePlan, executePlan } from '../build/plan';
import { interpret, knownSubjects } from '../build/interpreter';
import {
  LLMConfig, PROVIDER_DEFAULTS, ProviderKind, generateProgram, loadConfig, probeProvider, saveConfig,
} from '../build/llm';
import { DEFAULT_LIMITS, RunResult, runProgramSandboxed } from '../build/sandbox';
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
    placeholder: 'Build anything — "a spiral staircase", "a gear with 24 teeth", "a wooden table"',
  });
  private codePanel = h('div', { class: 'build-code hidden' });
  private codeArea = h('textarea', { class: 'code-area' });
  private codeLog = h('pre', { class: 'code-log' });
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
      // (Cmd+K, Cmd+Shift+B) still have to work from inside the field.
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
        button('Code', () => this.toggleCode(), { title: 'Show and edit the program that builds it' }),
        this.statusChip,
      ]),
      this.note,
      this.buildCodePanel(),
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
    this.note.textContent = this.modelReady
      ? `${this.config.model} writes the program; press Code to read or edit it.`
      : `Anything at all needs a model — press the chip to connect one. Without it: ${subjects.length} built-in subjects, shape arrangements, or your own code under Code.`;
  }

  private buildCodePanel(): HTMLElement {
    this.codeArea.spellcheck = false;
    this.codeArea.placeholder =
      "// Write a program, or press Go and let a model write one.\n// for (let i = 0; i < 12; i++) {\n//   const a = i / 12 * TAU;\n//   cyl(cos(a) * 2, sin(a) * 2, 1, 0.3, 0.3, 2, '#8b5e34');\n// }";
    this.codeArea.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.runCode(this.codeArea.value, 'your code');
      }
    });
    this.codePanel.append(
      this.codeArea,
      h('div', { class: 'btn-row' }, [
        button('Run', () => void this.runCode(this.codeArea.value, 'your code'), { class: 'primary' }),
        button('Copy', () => void navigator.clipboard?.writeText(this.codeArea.value)),
        button('Hide', () => this.toggleCode()),
      ]),
      h('p', { class: 'dim small', text: 'Cmd/Ctrl+Enter runs it. Runs in a sandbox with no network and a 3 second limit.' }),
      this.codeLog,
    );
    return this.codePanel;
  }

  private toggleCode(): void {
    this.codePanel.classList.toggle('hidden');
    if (!this.codePanel.classList.contains('hidden')) this.codeArea.focus();
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

    // With a model connected, everything goes through generated code — that is
    // what makes arbitrary requests possible. Without one, fall back to the
    // built-in subjects so the box is never simply dead.
    if (this.modelReady) {
      await this.runModel(prompt);
      return;
    }

    const offline = interpret(prompt);
    if (offline.plan) {
      this.apply(offline.plan, prompt);
      this.note.textContent += '  Connect a model (the chip on the right) to build things with no built-in recipe.';
      return;
    }
    this.note.textContent = `${offline.reason ?? 'Could not build that.'}`;
    this.editor.setStatus('Nothing built — connect a local model to build anything');
  }

  private async runModel(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.running = controller;
    this.setChip('writing code…', 'busy');
    this.note.textContent = `${this.config.model} is writing a program…`;

    let result: RunResult | null = null;
    const verify = async (code: string): Promise<void> => {
      result = await runProgramSandboxed(code, DEFAULT_LIMITS);
    };

    try {
      const program = await generateProgram(this.config, prompt, verify, controller.signal);
      this.codeArea.value = program.code;
      const run = result as RunResult | null;
      if (!run) throw new Error('The program produced nothing.');
      this.apply(
        { name: prompt.slice(0, 30), parts: run.parts, source: `${this.config.model}` },
        prompt,
        `${program.seconds.toFixed(1)}s`,
      );
      this.codeLog.textContent = run.log.join('\n');
      this.setChip(this.config.model, 'ok');
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.setChip(this.config.model, aborted ? 'idle' : 'bad');
      this.note.textContent = aborted ? 'Cancelled.' : (err as Error).message;
      if (!aborted && this.codeArea.value) {
        this.codePanel.classList.remove('hidden');
        this.codeLog.textContent = 'The last program is above — you can fix it and press Run.';
      }
    } finally {
      this.running = null;
    }
  }

  /** Run whatever is in the code box, whether a model or a person wrote it. */
  private async runCode(code: string, source: string): Promise<void> {
    if (!code.trim()) return;
    this.codeLog.textContent = '';
    try {
      const run = await runProgramSandboxed(code, DEFAULT_LIMITS);
      this.apply(
        { name: this.input.value.trim().slice(0, 30) || 'Program', parts: run.parts, source },
        this.input.value.trim() || 'program',
        `${run.ms}ms`,
      );
      this.codeLog.textContent = run.log.join('\n');
    } catch (err) {
      this.codeLog.textContent = (err as Error).message;
      this.editor.setStatus(`The program did not run: ${(err as Error).message}`);
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
      h('span', { text: 'Everything above works with no model at all. Connect one and Kline can build things it has no recipe for. ' }),
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
      this.showHint();
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
