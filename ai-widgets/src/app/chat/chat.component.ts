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
import { imagesFromTransfer, isSupportedImage, prepareImage } from './attachments';
import {
  ChatAttachment,
  ChatMessage,
  ContextInfo,
  FailedTurn,
  ModelInfo,
} from './chat.models';
import { ChatHttpError, ChatService, SendBody } from './chat.service';

type Phase = 'setup' | 'chat' | 'closed';

/** Насколько близко к низу нужно быть, чтобы автоскролл считался желанным */
const STICK_TO_BOTTOM_PX = 80;

@Component({
  selector: 'app-chat',
  imports: [FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent {
  private readonly chat = inject(ChatService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly scrollBox = viewChild<ElementRef<HTMLElement>>('scrollBox');
  private readonly composerField =
    viewChild<ElementRef<HTMLTextAreaElement>>('composerField');
  private readonly safeHtmlCache = new Map<string, SafeHtml>();

  private sessionId: string | null = null;
  /** Предупреждение о 80% показываем один раз на диалог */
  private warnShown = false;
  /** Прерывание текущего хода: кнопка «Стоп» и закрытие панели */
  private abortCtrl: AbortController | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  readonly open = signal(false);
  /** Панель развёрнута почти на весь экран (90vw × 90vh) */
  readonly expanded = signal(false);
  readonly phase = signal<Phase>('setup');
  readonly ldap = signal('i.ivanov');
  readonly fullName = signal('Иванов Иван Иванович');
  readonly messages = signal<ChatMessage[]>([]);
  readonly input = signal('');
  readonly busy = signal(false);
  readonly canClose = signal(false);
  readonly setupError = signal('');

  readonly models = signal<ModelInfo[]>([]);
  readonly modelsError = signal('');
  readonly modelId = signal('');
  readonly context = signal<ContextInfo | null>(null);
  readonly limitReached = signal(false);
  /** Сессия истекла на сервере — продолжать в ней нельзя */
  readonly sessionExpired = signal(false);
  /** Последний упавший ход: даёт кнопку «Повторить» без перенабора */
  readonly failedTurn = signal<FailedTurn | null>(null);
  /** Пользователь отвёл ленту от низа — автоскролл не мешаем */
  readonly stuckToBottom = signal(true);
  readonly hasNewBelow = signal(false);
  /** Двухшаговое подтверждение необратимых действий */
  readonly pendingConfirm = signal<'new' | 'end' | null>(null);
  readonly copiedIndex = signal<number | null>(null);

  /** Картинки, выбранные и уже загруженные на сервер, но ещё не отправленные */
  readonly pending = signal<ChatAttachment[]>([]);
  readonly uploading = signal(false);
  /** Курсор над панелью с файлом — подсвечиваем зону */
  readonly dragOver = signal(false);
  /** Картинка, открытая на весь экран по клику в ленте */
  readonly lightbox = signal<ChatAttachment | null>(null);

  /** Порог предупреждения приходит с сервера; сигнал, иначе computed не пересчитается */
  private readonly warnRatio = signal(0.8);

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
    if (percent >= this.warnRatio() * 100) return 'warn';
    return 'ok';
  });

  /** Ввод заблокирован — по лимиту контекста или потому что сессии больше нет */
  readonly inputBlocked = computed(
    () => this.limitReached() || this.sessionExpired()
  );

  constructor() {
    void this.loadModels();
  }

  private async loadModels(): Promise<void> {
    this.modelsError.set('');
    try {
      const data = await this.chat.listModels();
      this.models.set(data.models);
      this.warnRatio.set(data.warnRatio);
      if (!this.modelId()) this.modelId.set(data.defaultModelId);
    } catch (err) {
      // Раньше ошибка глушилась и селектор просто не появлялся —
      // отличить это от «сборки без выбора модели» было нельзя
      this.modelsError.set(
        err instanceof Error ? err.message : 'Модели недоступны'
      );
    }
  }

  retryLoadModels(): void {
    void this.loadModels();
  }

  togglePanel(): void {
    this.open.update((v) => !v);
    if (this.open()) this.scrollDown(true);
  }

  toggleExpandPanel(): void {
    this.expanded.update((v) => !v);
    // Ширина ленты меняется — держим прокрутку у последних сообщений
    this.scrollDown(true);
  }

  /**
   * Авторост поля ввода, как у больших чатов: высота следует за контентом.
   * Сначала сбрасываем в auto, иначе scrollHeight не уменьшается при
   * удалении строк; потолок задаёт max-height в стилях.
   */
  onInputChange(value: string): void {
    this.input.set(value);
    this.autoGrowComposer();
  }

  private autoGrowComposer(): void {
    const el = this.composerField()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  /** После программной очистки поля DOM обновится только после рендера */
  private resetComposerHeight(): void {
    setTimeout(() => this.autoGrowComposer());
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
    this.sessionExpired.set(false);
    this.failedTurn.set(null);
    this.context.set(null);
    this.warnShown = false;
    this.stuckToBottom.set(true);
    this.hasNewBelow.set(false);
    this.pending.set([]);
    this.lightbox.set(null);
    this.safeHtmlCache.clear();
  }

  async changeModel(modelId: string): Promise<void> {
    if (!modelId || modelId === this.modelId()) return;
    const previous = this.modelId();
    this.modelId.set(modelId);
    if (!this.sessionId) return;
    try {
      await this.chat.setModel(this.sessionId, modelId);
    } catch (err) {
      this.modelId.set(previous);
      // Молчаливый откат селектора выглядел как баг интерфейса
      this.pushSystemMessage(
        err instanceof Error ? err.message : 'Не удалось сменить модель'
      );
    }
  }

  // ——— Вложения ———

  /** Три пути добавления — кнопка, перетаскивание, вставка — один обработчик */
  async addFiles(files: File[]): Promise<void> {
    if (this.inputBlocked()) return;
    if (!this.sessionId) {
      // Молчать нельзя: пользователь вставил картинку и не понял бы, почему ничего не произошло
      this.handleSessionGone();
      return;
    }
    const images = files.filter(isSupportedImage);
    if (!images.length) {
      if (files.length) {
        this.pushSystemMessage('Можно приложить только PNG, JPEG или WebP.');
      }
      return;
    }

    this.uploading.set(true);
    try {
      for (const file of images) {
        const prepared = await prepareImage(file);
        const uploaded = await this.chat.uploadAttachment(this.sessionId, prepared);
        this.pending.update((list) => [
          ...list,
          {
            id: uploaded.id,
            name: uploaded.name,
            dataUrl: prepared.dataUrl,
            sizeBytes: uploaded.sizeBytes,
          },
        ]);
      }
    } catch (err) {
      // Истёкшая сессия при загрузке — та же ситуация, что при отправке:
      // нужен не сухой текст ошибки, а выход в новый диалог
      if (err instanceof ChatHttpError && err.status === 404) {
        this.handleSessionGone();
      } else {
        this.pushSystemMessage(
          err instanceof Error ? err.message : 'Не удалось приложить картинку'
        );
      }
    } finally {
      this.uploading.set(false);
    }
  }

  /** Сессии на сервере больше нет: чистим локальное состояние и даём выход */
  private handleSessionGone(): void {
    this.sessionId = null;
    this.sessionExpired.set(true);
    this.pending.set([]);
    this.pushNotice('expired');
    this.scrollDown();
  }

  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.addFiles(Array.from(input.files ?? []));
    // Сброс, иначе повторный выбор того же файла не вызовет change
    input.value = '';
  }

  /**
   * Вставка ловится на уровне документа, а не только на поле ввода: событие
   * paste приходит сфокусированному элементу, и если пользователь щёлкнул
   * куда-то ещё в панели, обработчик на textarea бы не сработал. Ожидание —
   * «вставляю картинку в чат», а не «в конкретное поле».
   *
   * Текстовую вставку не трогаем: выходим сразу, если картинок в буфере нет.
   */
  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    if (!this.open() || this.phase() !== 'chat') return;
    const images = imagesFromTransfer(event.clipboardData);
    if (!images.length) return;
    event.preventDefault();
    void this.addFiles(images);
  }

  onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(): void {
    this.dragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    const images = imagesFromTransfer(event.dataTransfer);
    event.preventDefault();
    this.dragOver.set(false);
    if (images.length) void this.addFiles(images);
  }

  removePending(id: string): void {
    this.pending.update((list) => list.filter((a) => a.id !== id));
  }

  openLightbox(attachment: ChatAttachment): void {
    this.lightbox.set(attachment);
  }

  closeLightbox(): void {
    this.lightbox.set(null);
  }

  async send(): Promise<void> {
    const text = this.input().trim();
    const attachments = this.pending();
    // Картинку можно отправить и без подписи
    if ((!text && !attachments.length) || this.inputBlocked()) return;
    this.input.set('');
    this.pending.set([]);
    this.resetComposerHeight();
    await this.exchange(
      { text: text || undefined, attachmentIds: attachments.map((a) => a.id) },
      text || 'Вот изображение — сделай виджет по нему.',
      attachments
    );
  }

  async accept(index: number): Promise<void> {
    if (this.busy()) return;
    const variant = this.messages()[index]?.variant;
    this.messages.update((list) =>
      list.map((m, i) => (i === index ? { ...m, accepted: true } : m))
    );
    const ok = await this.exchange(
      { action: 'accept', variant },
      variant != null
        ? `Принимаю вариант #${variant} ✅`
        : 'Принимаю этот виджет ✅'
    );
    // Ход не прошёл — снимаем оптимистичную отметку, иначе кнопка навсегда
    // остаётся «Принято ✓», хотя сервер об этом не знает
    if (!ok) {
      this.messages.update((list) =>
        list.map((m, i) => (i === index ? { ...m, accepted: false } : m))
      );
    }
  }

  /** Взять старый вариант за основу — детерминированно, по номеру */
  async revisit(index: number): Promise<void> {
    if (this.busy() || this.inputBlocked()) return;
    const variant = this.messages()[index]?.variant;
    if (variant == null) return;
    const comment = this.input().trim();
    this.input.set('');
    this.resetComposerHeight();
    await this.exchange(
      { action: 'revisit', variant, text: comment || undefined },
      comment
        ? `Дорабатываем вариант #${variant}: ${comment}`
        : `Дорабатываем вариант #${variant}`
    );
  }

  /** Повторить упавший ход — без перенабора сообщения */
  async retry(): Promise<void> {
    const turn = this.failedTurn();
    if (!turn || this.busy() || this.inputBlocked()) return;
    this.failedTurn.set(null);
    // Картинки уже лежат в реестре сессии — повтор идёт по тем же id
    await this.exchange(turn.body, turn.shownText, turn.attachments ?? []);
  }

  /** Прервать генерацию. Сервер увидит закрытие соединения и остановит модель */
  stop(): void {
    this.abortCtrl?.abort();
  }

  private async exchange(
    body: SendBody,
    shownUserText: string,
    attachments: ChatAttachment[] = []
  ): Promise<boolean> {
    if (this.busy() || !this.sessionId) return false;
    this.busy.set(true);
    this.failedTurn.set(null);

    this.messages.update((list) => [
      ...list,
      {
        role: 'user',
        text: shownUserText,
        attachments: attachments.length ? attachments : undefined,
        time: this.now(),
      },
      { role: 'assistant', text: '', streaming: true, time: this.now() },
    ]);
    this.scrollDown();

    const abort = new AbortController();
    this.abortCtrl = abort;
    let ok = true;

    try {
      await this.chat.streamMessage(
        this.sessionId,
        body,
        (event) => {
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
                reasoningTokens: event.reasoningTokens,
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
              if (event.truncated) this.patchLast({ truncated: true });
              break;

            case 'error':
              ok = false;
              this.showStreamError(
                event.error,
                event.retryable,
                body,
                shownUserText,
                attachments
              );
              break;
          }
          this.scrollDown();
        },
        abort.signal
      );
    } catch (err) {
      ok = false;
      this.handleTurnFailure(err, body, shownUserText, attachments);
    } finally {
      this.abortCtrl = null;
      this.patchLast({ streaming: false, buildingWidget: false });
      this.dropEmptyTail();
      this.busy.set(false);
      this.scrollDown();
    }
    return ok;
  }

  /**
   * Ошибка пришла событием внутри потока. Уже полученный текст сохраняем —
   * раньше он затирался сообщением об ошибке целиком.
   */
  private showStreamError(
    text: string,
    retryable: boolean,
    body: SendBody,
    shownText: string,
    attachments: ChatAttachment[] = []
  ): void {
    const last = this.messages().at(-1);
    const prefix = last?.text ? `${last.text}\n\n` : '';
    this.patchLast({
      text: `${prefix}⚠️ ${text}`,
      error: true,
      retryable,
      streaming: false,
      buildingWidget: false,
    });
    if (retryable) this.failedTurn.set({ body, shownText, attachments });
  }

  private handleTurnFailure(
    err: unknown,
    body: SendBody,
    shownText: string,
    attachments: ChatAttachment[] = []
  ): void {
    // Прерывание пользователем — не ошибка, помечаем как остановленный ход
    if (err instanceof DOMException && err.name === 'AbortError') {
      const last = this.messages().at(-1);
      this.patchLast({
        text: last?.text ? `${last.text}\n\n⏹ Остановлено.` : '⏹ Остановлено.',
        stopped: true,
        retryable: true,
        streaming: false,
        buildingWidget: false,
      });
      this.failedTurn.set({ body, shownText, attachments });
      return;
    }

    // Сессии больше нет: раньше каждая следующая отправка повторяла ту же
    // ошибку бесконечно, потому что sessionId не сбрасывался
    if (err instanceof ChatHttpError && err.status === 404) {
      this.patchLast({
        text: '⚠️ Диалог истёк — сервер уже удалил его историю.',
        error: true,
        streaming: false,
      });
      this.handleSessionGone();
      return;
    }

    const retryable =
      err instanceof ChatHttpError ? err.retryable : true;
    const text =
      err instanceof ChatHttpError
        ? err.message
        : 'Не удалось связаться с сервером. Проверьте соединение.';

    const last = this.messages().at(-1);
    const prefix = last?.text ? `${last.text}\n\n` : '';
    this.patchLast({
      text: `${prefix}⚠️ ${text}`,
      error: true,
      retryable,
      streaming: false,
      buildingWidget: false,
    });
    if (retryable) this.failedTurn.set({ body, shownText, attachments });
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
    if (percent >= this.warnRatio() * 100 && !this.warnShown) {
      this.warnShown = true;
      this.pushNotice('warn');
    }
  }

  private pushNotice(kind: 'warn' | 'limit' | 'expired'): void {
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

  private pushSystemMessage(text: string): void {
    this.messages.update((list) => [
      ...list,
      { role: 'assistant', text: `⚠️ ${text}`, error: true, time: this.now() },
    ]);
    this.scrollDown();
  }

  /** Первый клик спрашивает, второй выполняет — необратимое не должно быть в один тап */
  confirmDestructive(action: 'new' | 'end'): void {
    if (this.pendingConfirm() === action) {
      this.clearConfirm();
      void (action === 'new' ? this.newDialog() : this.endDialog());
      return;
    }
    this.pendingConfirm.set(action);
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => this.pendingConfirm.set(null), 4000);
  }

  private clearConfirm(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.pendingConfirm.set(null);
  }

  async endDialog(): Promise<void> {
    this.stop();
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
      this.scrollDown(true);
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

  /** Превью 200px — замочная скважина для виджета под нормальный экран */
  toggleExpand(index: number): void {
    this.messages.update((list) =>
      list.map((m, i) => (i === index ? { ...m, expanded: !m.expanded } : m))
    );
  }

  async copyCode(html: string, index: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(html);
      this.flashCopied(index);
    } catch {
      // На не-HTTPS буфер недоступен, и раньше провал выглядел как успех
      this.pushSystemMessage(
        'Буфер обмена недоступен. Откройте блок «Код» и скопируйте вручную.'
      );
    }
  }

  private flashCopied(index: number): void {
    this.copiedIndex.set(index);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copiedIndex.set(null), 2000);
  }

  trustHtml(html: string): SafeHtml {
    let safe = this.safeHtmlCache.get(html);
    if (!safe) {
      safe = this.sanitizer.bypassSecurityTrustHtml(html);
      this.safeHtmlCache.set(html, safe);
    }
    return safe;
  }

  /** Пользователь листает историю — запоминаем, чтобы не дёргать его вниз */
  onScroll(): void {
    const el = this.scrollBox()?.nativeElement;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
    this.stuckToBottom.set(atBottom);
    if (atBottom) this.hasNewBelow.set(false);
  }

  jumpToLatest(): void {
    this.stuckToBottom.set(true);
    this.hasNewBelow.set(false);
    this.scrollDown(true);
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

  private now(): string {
    return new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
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
    // Размышления оплачиваются, но в контексте не остаются — у Gemini 3 заметны
    if (ctx.reasoningTokens) {
      parts.push(`На размышления: ${this.fmtTokens(ctx.reasoningTokens)} токенов`);
    }
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

  /**
   * Прокрутка вниз. `force` — по явному действию пользователя; в остальных
   * случаях уважаем то, что он мог отлистать ленту вверх, чтобы перечитать
   * старый вариант: раньше следующая же дельта возвращала его вниз.
   */
  private scrollDown(force = false): void {
    if (!force && !this.stuckToBottom()) {
      this.hasNewBelow.set(true);
      return;
    }
    setTimeout(() => {
      const el = this.scrollBox()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
