import {
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ChatMessage } from './chat.models';
import { ChatService } from './chat.service';

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

  readonly phase = signal<Phase>('setup');
  readonly ldap = signal('i.ivanov');
  readonly fullName = signal('Иванов Иван Иванович');
  readonly messages = signal<ChatMessage[]>([]);
  readonly input = signal('');
  readonly busy = signal(false);
  readonly canClose = signal(false);
  readonly setupError = signal('');

  async startSession(): Promise<void> {
    if (this.busy() || !this.ldap().trim() || !this.fullName().trim()) return;
    this.busy.set(true);
    this.setupError.set('');
    try {
      this.sessionId = await this.chat.createSession(
        this.ldap().trim(),
        this.fullName().trim()
      );
      this.messages.set([
        {
          role: 'assistant',
          text: `Здравствуйте, ${this.fullName().trim()}! Опишите, какой HTML-виджет вам нужен (без JavaScript), — я предложу вариант, а вы сможете уточнять его, пока не нажмёте «Принять».`,
        },
      ]);
      this.canClose.set(false);
      this.phase.set('chat');
    } catch (err) {
      this.setupError.set(
        err instanceof Error ? err.message : 'Не удалось создать сессию'
      );
    } finally {
      this.busy.set(false);
    }
  }

  async send(): Promise<void> {
    const text = this.input().trim();
    if (!text) return;
    this.input.set('');
    await this.exchange({ text }, text);
  }

  async accept(index: number): Promise<void> {
    if (this.busy()) return;
    this.messages.update((list) =>
      list.map((m, i) => (i === index ? { ...m, accepted: true } : m))
    );
    await this.exchange({ action: 'accept' }, 'Принимаю этот виджет ✅');
  }

  private async exchange(
    body: { text?: string; action?: 'accept' },
    shownUserText: string
  ): Promise<void> {
    if (this.busy() || !this.sessionId) return;
    this.busy.set(true);

    this.messages.update((list) => [
      ...list,
      { role: 'user', text: shownUserText },
      { role: 'assistant', text: '', streaming: true },
    ]);
    this.scrollDown();

    try {
      await this.chat.streamMessage(this.sessionId, body, (event) => {
        if (event.type === 'partial') {
          this.patchLast({ text: event.message });
        } else if (event.type === 'final') {
          this.patchLast({
            text: event.message,
            widgetHtml: event.widgetHtml,
            streaming: false,
          });
          if (event.canClose) this.canClose.set(true);
        } else {
          this.patchLast({ text: event.error, error: true, streaming: false });
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
      this.patchLast({ streaming: false });
      this.busy.set(false);
      this.scrollDown();
    }
  }

  async endDialog(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.chat.endSession(this.sessionId);
      } catch {
        /* сервер мог быть недоступен — всё равно закрываем локально */
      }
    }
    this.sessionId = null;
    this.phase.set('closed');
  }

  newDialog(): void {
    this.messages.set([]);
    this.canClose.set(false);
    this.phase.set('setup');
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

  private patchLast(patch: Partial<ChatMessage>): void {
    this.messages.update((list) => {
      if (!list.length) return list;
      const copy = [...list];
      copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
      return copy;
    });
  }

  private scrollDown(): void {
    setTimeout(() => {
      const el = this.scrollBox()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
