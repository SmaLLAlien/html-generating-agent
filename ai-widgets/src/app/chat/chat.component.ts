import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ChatMessage, ContextInfo, ModelInfo } from './chat.models';
import { ChatService, SendBody } from './chat.service';

type Phase = 'setup' | 'chat' | 'closed';

@Component({
  selector: 'app-chat',
  imports: [FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent {
  private readonly chat = inject(ChatService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly scrollBox = viewChild<ElementRef<HTMLElement>>('scrollBox');
  private readonly safeHtmlCache = new Map<string, SafeHtml>();

  private sessionId: string | null = null;
  /** Предупреждение о 80% показываем один раз на диалог */
  private warnShown = false;

  readonly open = signal(false);
  readonly phase = signal<Phase>('setup');
  readonly ldap = signal('i.ivanov');
  readonly fullName = signal('Иванов Иван Иванович');
  readonly messages = signal<ChatMessage[]>([]);
  readonly input = signal('');
  readonly busy = signal(false);
  readonly canClose = signal(false);
  readonly setupError = signal('');

  readonly models = signal<ModelInfo[]>([]);
  readonly modelId = signal('');
  readonly context = signal<ContextInfo | null>(null);
  readonly limitReached = signal(false);
  private warnRatio = 0.8;

  readonly currentModel = computed(() =>
    this.models().find((m) => m.id === this.modelId())
  );

  /** Доля бюджета в процентах, обрезанная сотней — для ширины полосы */
  readonly contextPercent = computed(() =>
    Math.min(100, this.context()?.percent ?? 0)
  );

  readonly contextLevel = computed(() => {
    const percent = this.context()?.percent ?? 0;
    if (percent >= 100) return 'danger';
    if (percent >= this.warnRatio * 100) return 'warn';
    return 'ok';
  });

  constructor() {
    void this.loadModels();
  }

  private async loadModels(): Promise<void> {
    try {
      const data = await this.chat.listModels();
      this.models.set(data.models);
      this.warnRatio = data.warnRatio;
      if (!this.modelId()) this.modelId.set(data.defaultModelId);
    } catch {
      /* список моделей не критичен — селектор просто не появится */
    }
  }

  togglePanel(): void {
    this.open.update((v) => !v);
    if (this.open()) this.scrollDown();
  }

  async startSession(): Promise<void> {
    if (this.busy() || !this.ldap().trim() || !this.fullName().trim()) return;
    this.busy.set(true);
    this.setupError.set('');
    try {
      const { sessionId, modelId } = await this.chat.createSession(
        this.ldap().trim(),
        this.fullName().trim()
      );
      this.sessionId = sessionId;
      this.modelId.set(modelId);
      this.resetConversation();
      this.phase.set('chat');
    } catch (err) {
      this.setupError.set(
        err instanceof Error ? err.message : 'Не удалось создать сессию'
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Приветствие и чистый локальный стейт. Серверная сессия уже создана. */
  private resetConversation(): void {
    this.messages.set([
      {
        role: 'assistant',
        text: `Здравствуйте, ${this.fullName().trim()}! Опишите, какой HTML-виджет вам нужен (без JavaScript), — я предложу вариант, а вы сможете уточнять его, пока не нажмёте «Принять».`,
        time: this.now(),
      },
    ]);
    this.canClose.set(false);
    this.limitReached.set(false);
    this.context.set(null);
    this.warnShown = false;
    this.safeHtmlCache.clear();
  }

  async changeModel(modelId: string): Promise<void> {
    if (!modelId || modelId === this.modelId()) return;
    const previous = this.modelId();
    this.modelId.set(modelId);
    if (!this.sessionId) return;
    try {
      await this.chat.setModel(this.sessionId, modelId);
    } catch {
      this.modelId.set(previous);
    }
  }

  async send(): Promise<void> {
    const text = this.input().trim();
    if (!text || this.limitReached()) return;
    this.input.set('');
    await this.exchange({ text }, text);
  }

  async accept(index: number): Promise<void> {
    if (this.busy()) return;
    const variant = this.messages()[index]?.variant;
    this.messages.update((list) =>
      list.map((m, i) => (i === index ? { ...m, accepted: true } : m))
    );
    await this.exchange(
      { action: 'accept', variant },
      variant != null
        ? `Принимаю вариант #${variant} ✅`
        : 'Принимаю этот виджет ✅'
    );
  }

  /** Взять старый вариант за основу — детерминированно, по номеру */
  async revisit(index: number): Promise<void> {
    if (this.busy() || this.limitReached()) return;
    const variant = this.messages()[index]?.variant;
    if (variant == null) return;
    const comment = this.input().trim();
    this.input.set('');
    await this.exchange(
      { action: 'revisit', variant, text: comment || undefined },
      comment
        ? `Дорабатываем вариант #${variant}: ${comment}`
        : `Дорабатываем вариант #${variant}`
    );
  }

  private async exchange(
    body: SendBody,
    shownUserText: string
  ): Promise<void> {
    if (this.busy() || !this.sessionId) return;
    this.busy.set(true);

    this.messages.update((list) => [
      ...list,
      { role: 'user', text: shownUserText, time: this.now() },
      { role: 'assistant', text: '', streaming: true, time: this.now() },
    ]);
    this.scrollDown();

    try {
      await this.chat.streamMessage(this.sessionId, body, (event) => {
        switch (event.type) {
          case 'text':
            this.appendText(event.delta);
            break;

          case 'status':
            if (event.stage === 'widget-start') {
              this.patchLast({ buildingWidget: true });
            }
            break;

          case 'widget':
            this.attachWidget(event);
            break;

          case 'usage':
            this.context.set({
              contextTokens: event.contextTokens,
              budget: event.budget,
              percent: event.percent,
              cachedTokens: event.cachedTokens,
            });
            this.checkContext(event.percent);
            break;

          case 'limit':
            this.context.set({
              contextTokens: event.contextTokens,
              budget: event.budget,
              percent: 100,
            });
            this.limitReached.set(true);
            this.pushNotice('limit');
            break;

          case 'done':
            if (event.finished) this.canClose.set(true);
            break;

          case 'error':
            this.patchLast({
              text: event.error,
              error: true,
              streaming: false,
              buildingWidget: false,
            });
            break;
        }
        this.scrollDown();
      });
    } catch (err) {
      this.patchLast({
        text:
          err instanceof Error ? err.message : 'Ошибка соединения с сервером',
        error: true,
        streaming: false,
      });
    } finally {
      this.patchLast({ streaming: false, buildingWidget: false });
      this.dropEmptyTail();
      this.busy.set(false);
      this.scrollDown();
    }
  }

  private attachWidget(event: {
    variant: number;
    title: string;
    basedOn: number | null;
    html: string;
  }): void {
    const patch = {
      widgetHtml: event.html,
      variant: event.variant,
      variantTitle: event.title,
      basedOn: event.basedOn,
      buildingWidget: false,
    };

    const last = this.messages().at(-1);
    // За один ход агент может выдать несколько виджетов — тогда каждому свой пузырь
    if (last && last.role === 'assistant' && !last.widgetHtml) {
      this.patchLast(patch);
    } else {
      this.messages.update((list) => [
        ...list,
        { role: 'assistant', text: '', streaming: true, time: this.now(), ...patch },
      ]);
    }
  }

  private checkContext(percent: number): void {
    if (percent >= 100) {
      this.limitReached.set(true);
      this.pushNotice('limit');
      return;
    }
    if (percent >= this.warnRatio * 100 && !this.warnShown) {
      this.warnShown = true;
      this.pushNotice('warn');
    }
  }

  private pushNotice(kind: 'warn' | 'limit'): void {
    // Не дублируем одну и ту же плашку подряд
    if (this.messages().at(-1)?.notice === kind) return;
    this.messages.update((list) => [
      ...list,
      {
        role: 'assistant',
        text: '',
        notice: kind,
        noticePercent: this.context()?.percent ?? 0,
        time: this.now(),
      },
    ]);
  }

  async endDialog(): Promise<void> {
    await this.dropSession();
    this.phase.set('closed');
  }

  /** Новый диалог: старая сессия удаляется на сервере вместе с историей и вариантами */
  async newDialog(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.dropSession();
      const { sessionId, modelId } = await this.chat.createSession(
        this.ldap().trim(),
        this.fullName().trim()
      );
      this.sessionId = sessionId;
      this.modelId.set(modelId);
      this.resetConversation();
      this.phase.set('chat');
    } catch (err) {
      this.setupError.set(
        err instanceof Error ? err.message : 'Не удалось создать сессию'
      );
      this.phase.set('setup');
    } finally {
      this.busy.set(false);
      this.scrollDown();
    }
  }

  private async dropSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.chat.endSession(this.sessionId);
    } catch {
      /* сервер мог быть недоступен — всё равно закрываем локально */
    }
    this.sessionId = null;
  }

  @HostListener('window:beforeunload')
  onUnload(): void {
    if (this.sessionId) this.chat.closeOnUnload(this.sessionId);
  }

  toggleCode(index: number): void {
    this.messages.update((list) =>
      list.map((m, i) => (i === index ? { ...m, showCode: !m.showCode } : m))
    );
  }

  async copyCode(html: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(html);
    } catch {
      /* буфер обмена недоступен (например, не HTTPS) */
    }
  }

  trustHtml(html: string): SafeHtml {
    let safe = this.safeHtmlCache.get(html);
    if (!safe) {
      safe = this.sanitizer.bypassSecurityTrustHtml(html);
      this.safeHtmlCache.set(html, safe);
    }
    return safe;
  }

  private appendText(delta: string): void {
    this.messages.update((list) => {
      if (!list.length) return list;
      const copy = [...list];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, text: last.text + delta };
      return copy;
    });
  }

  private patchLast(patch: Partial<ChatMessage>): void {
    this.messages.update((list) => {
      if (!list.length) return list;
      const copy = [...list];
      copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
      return copy;
    });
  }

  /** Агент мог закончить ход вызовом инструмента без текста — пустой пузырь убираем */
  private dropEmptyTail(): void {
    this.messages.update((list) => {
      const last = list.at(-1);
      if (
        last &&
        last.role === 'assistant' &&
        !last.text &&
        !last.widgetHtml &&
        !last.notice
      ) {
        return list.slice(0, -1);
      }
      return list;
    });
  }

  /** Подсказка под полосой контекста: бюджет, окно модели и попадания в кеш */
  readonly contextTooltip = computed(() => {
    const ctx = this.context();
    if (!ctx) return '';
    const parts = [
      `Использовано ${ctx.contextTokens} из ${ctx.budget} токенов рабочего бюджета`,
    ];
    const model = this.currentModel();
    if (model) {
      parts.push(`Окно модели: ${this.fmtTokens(model.contextWindow)} токенов`);
    }
    // Неявный кеш Gemini удешевляет входные токены в 10 раз — показываем,
    // работает ли он вообще
    parts.push(
      ctx.cachedTokens
        ? `Из кеша: ${this.fmtTokens(ctx.cachedTokens)} токенов`
        : 'Из кеша: нет попаданий'
    );
    return parts.join('\n');
  });

  /** 124000 → «124k», чтобы полоса контекста не расползалась */
  fmtTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    // До 10k округление до тысяч слишком грубое: 2500 превратилось бы в «3k»
    if (value >= 10_000) return `${Math.round(value / 1000)}k`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(value);
  }

  private now(): string {
    return new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private scrollDown(): void {
    setTimeout(() => {
      const el = this.scrollBox()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
