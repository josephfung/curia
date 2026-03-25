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

  constructor(bus: EventBus, logger: Logger) {
    this.bus = bus;
    this.logger = logger;
  }

  start(): void {
    // Subscribe to outbound messages directed at the CLI channel.
    // We filter by channelId === 'cli' because the bus delivers to all
    // outbound.message subscribers regardless of destination channel.
    this.bus.subscribe('outbound.message', 'channel', (event) => {
      if (event.type === 'outbound.message' && event.payload.channelId === 'cli') {
        const outbound = event as OutboundMessageEvent;
        // Write response before the next prompt so the layout reads naturally:
        // user input → blank line → assistant reply → blank line → prompt
        process.stdout.write(`\n${outbound.payload.content}\n\n> `);
      }
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    this.rl.prompt();

    this.rl.on('line', (line) => {
      const content = line.trim();

      // Skip blank lines — just re-prompt without publishing an event
      if (!content) {
        this.rl?.prompt();
        return;
      }

      // Exit commands — clean shutdown rather than SIGINT
      if (content === '/quit' || content === '/exit') {
        this.logger.info('CLI exit requested');
        this.stop();
        return;
      }

      const event = createInboundMessage({
        conversationId: 'cli:local:default',
        channelId: 'cli',
        senderId: 'local-user',
        content,
      });

      // Publish to bus — errors are logged, not thrown (don't crash the REPL).
      // Using void + .catch to handle the Promise without blocking readline's
      // synchronous 'line' event callback, which does not support async.
      void this.bus.publish('channel', event).catch((err) => {
        this.logger.error({ err }, 'Failed to publish CLI message');
      });
    });

    this.logger.info('CLI adapter started');
  }

  stop(): void {
    this.rl?.close();
    this.logger.info('CLI adapter stopped');
  }
}
