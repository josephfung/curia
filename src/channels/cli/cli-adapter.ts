import * as readline from 'node:readline';
import type { EventBus } from '../../bus/bus.js';
import { createInboundMessage } from '../../bus/events.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import type { Logger } from '../../logger.js';

/**
 * CLI channel adapter — interactive terminal I/O for local development and testing.
 * Reads from stdin, writes to stdout. Registers as layer: "channel" on the bus,
 * so it can only publish inbound.message and subscribe to outbound.message.
 *
 * This adapter is intentionally simple: no auth, no session persistence, single
 * hardcoded conversation ID ("cli:local:default"). It exists so the full pipeline
 * (channel → dispatch → agent → dispatch → channel) can be exercised without
 * a real messaging platform.
 */
export class CliAdapter {
  private bus: EventBus;
  private logger: Logger;
  private rl?: readline.Interface;
  private onExit?: () => void;

  constructor(bus: EventBus, logger: Logger, onExit?: () => void) {
    this.bus = bus;
    this.logger = logger;
    this.onExit = onExit;
  }

  start(): void {
    // Subscribe to outbound messages directed at the CLI channel.
    this.bus.subscribe('outbound.message', 'channel', (event) => {
      if (event.type === 'outbound.message' && event.payload.channelId === 'cli') {
        const outbound = event as OutboundMessageEvent;
        // Clear the current prompt line, write response, re-prompt
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`\n${outbound.payload.content}\n\n`);
        this.rl?.prompt();
      }
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
      // Let us handle SIGINT ourselves rather than readline's default behavior
      // which just emits 'close' — we want a clean shutdown sequence
    });

    // Handle Ctrl+C — process SIGINT directly since readline can swallow it
    process.on('SIGINT', () => {
      process.stdout.write('\n');
      this.stop();
    });

    // Handle readline close (e.g., stdin EOF)
    this.rl.on('close', () => {
      this.logger.info('CLI closed');
      if (this.onExit) {
        this.onExit();
      } else {
        process.exit(0);
      }
    });

    this.rl.prompt();

    this.rl.on('line', (line) => {
      const content = line.trim();

      if (!content) {
        this.rl?.prompt();
        return;
      }

      if (content === '/quit' || content === '/exit') {
        this.stop();
        return;
      }

      const event = createInboundMessage({
        conversationId: 'cli:local:default',
        channelId: 'cli',
        senderId: 'local-user',
        content,
      });

      void this.bus.publish('channel', event).catch((err) => {
        this.logger.error({ err }, 'Failed to publish CLI message');
        this.rl?.prompt();
      });
    });

    this.logger.info('CLI adapter started');
  }

  prompt(): void {
    this.rl?.prompt();
  }

  stop(): void {
    this.rl?.close();
  }
}
