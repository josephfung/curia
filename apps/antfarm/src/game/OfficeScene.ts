import Phaser from 'phaser';
import type { SceneDirective } from '@curia/shared-types';
import type { DeskSlot } from '../layout/desk-layout.js';
import { appearanceForAgent } from './agent-appearance.js';
import {
  buildWorldLayout,
  deskPositionForAgent,
  type WorldLayout,
} from './world-layout.js';
import {
  ensureTintedTexture,
  registerPlaceholderTextures,
} from './placeholder-textures.js';

export interface OfficeSceneCallbacks {
  onAgentClick: (agentId: string, directive: SceneDirective | null) => void;
  onDirectiveClick: (directive: SceneDirective) => void;
}

export interface OfficeSceneData {
  desks: DeskSlot[];
  callbacks: OfficeSceneCallbacks;
}

interface AgentSprite {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Image;
  agentId: string;
  thinkBubble: Phaser.GameObjects.Image | null;
  speechBubble: Phaser.GameObjects.Text | null;
  stateTint: 'normal' | 'active' | 'error';
}

export class OfficeScene extends Phaser.Scene {
  private layout!: WorldLayout;
  private agents = new Map<string, AgentSprite>();
  private claw!: Phaser.GameObjects.Image;
  private taskCards = new Map<string, Phaser.GameObjects.Image>();
  private badgeGroup!: Phaser.GameObjects.Container;
  private callbacks!: OfficeSceneCallbacks;
  private lastDirectiveByAgent = new Map<string, SceneDirective>();

  constructor() {
    super({ key: 'OfficeScene' });
  }

  init(data: OfficeSceneData): void {
    this.callbacks = data.callbacks;
  }

  create(): void {
    registerPlaceholderTextures(this);

    const desks = this.registry.get('desks') as DeskSlot[] ?? [];
    this.layout = buildWorldLayout(desks);

    this.drawRoom();
    this.spawnFixedProps();
    this.spawnDesks();
    this.spawnAgents(desks);
    this.badgeGroup = this.add.container(0, 0);

    const pending = this.registry.get('pendingReplay') as SceneDirective[] | undefined;
    if (pending?.length) {
      this.registry.remove('pendingReplay');
      for (const directive of pending) {
        this.playDirective(directive);
      }
    }
  }

  updateLayout(desks: DeskSlot[]): void {
    this.registry.set('desks', desks);
    this.agents.clear();
    this.taskCards.clear();
    this.lastDirectiveByAgent.clear();
    this.scene.restart({ desks, callbacks: this.callbacks });
  }

  /** Reset scene state and replay directives up to the current scrub position. */
  resyncPlayback(directives: SceneDirective[], desks: DeskSlot[]): void {
    this.registry.set('desks', desks);
    this.registry.set('pendingReplay', directives);
    this.agents.clear();
    this.taskCards.clear();
    this.lastDirectiveByAgent.clear();
    this.scene.restart({ desks, callbacks: this.callbacks });
  }

  playDirective(directive: SceneDirective): void {
    this.recordDirectiveAgents(directive);
    switch (directive.kind) {
      case 'claw.deliver':
        this.animateClawDeliver(directive);
        break;
      case 'agent.state':
        this.setAgentState(directive.agentId, directive.state);
        break;
      case 'agent.walk':
        this.animateWalk(directive);
        break;
      case 'agent.speak':
        this.showSpeech(directive);
        break;
      case 'agent.think':
        this.setThinkBubble(directive);
        break;
      case 'tube.in':
        this.animateTube('in');
        break;
      case 'tube.out':
        this.animateTube('out');
        break;
      case 'task.appear':
        this.showTaskCard(directive);
        break;
      case 'task.trash':
        this.trashTask(directive);
        break;
      case 'badge':
        this.showBadge(directive);
        break;
    }
  }

  private drawRoom(): void {
    for (let x = 0; x < 800; x += 32) {
      for (let y = 60; y < 480; y += 32) {
        this.add.image(x + 16, y + 16, 'office-floor').setScale(2);
      }
    }
    this.add.rectangle(400, 30, 680, 4, 0x6a6a72).setOrigin(0.5);
  }

  private spawnFixedProps(): void {
    this.add.image(this.layout.tasksBoard.x, this.layout.tasksBoard.y, 'tasks-board').setScale(2);
    this.add.image(this.layout.scheduler.x, this.layout.scheduler.y, 'scheduler').setScale(2);
    this.add.image(this.layout.wastebasket.x, this.layout.wastebasket.y, 'wastebasket').setScale(2);
    this.add.image(this.layout.tubeIn.x, this.layout.tubeIn.y, 'tube').setScale(2).setTint(0x6a9a6a);
    this.add.image(this.layout.tubeOut.x, this.layout.tubeOut.y, 'tube').setScale(2).setTint(0x9a6a6a);

    this.claw = this.add.image(this.layout.clawTrack.idleX, this.layout.clawTrack.y, 'claw').setScale(2);
  }

  private spawnDesks(): void {
    for (const desk of this.layout.desks) {
      const key = desk.row === 'boss' ? 'desk-boss' : 'desk';
      const img = this.add.image(desk.x, desk.y + 20, key).setScale(2);
      img.setInteractive({ useHandCursor: true });
      img.on('pointerdown', () => {
        this.callbacks.onAgentClick(desk.agentId, this.directiveForAgent(desk.agentId));
      });
      this.add
        .text(desk.x, desk.y + 36, desk.agentId, { fontSize: '10px', color: '#e8f0dc' })
        .setOrigin(0.5);
    }
  }

  private spawnAgents(desks: DeskSlot[]): void {
    for (const desk of desks) {
      this.ensureAgent(desk.agentId);
    }
  }

  private ensureAgent(agentId: string): AgentSprite {
    const existing = this.agents.get(agentId);
    if (existing) return existing;

    const pos = deskPositionForAgent(this.layout, agentId);
    const appearance = appearanceForAgent(agentId);
    const texKey = ensureTintedTexture(this, 'character', appearance.outfitColor);

    const container = this.add.container(pos.x, pos.y - 10);
    const body = this.add.image(0, 0, texKey).setScale(2);
    body.setInteractive({ useHandCursor: true });
    body.on('pointerdown', () => {
      this.callbacks.onAgentClick(agentId, this.directiveForAgent(agentId));
    });

    container.add(body);

    const sprite: AgentSprite = {
      container,
      body,
      agentId,
      thinkBubble: null,
      speechBubble: null,
      stateTint: 'normal',
    };
    this.agents.set(agentId, sprite);
    return sprite;
  }

  private animateClawDeliver(directive: SceneDirective & { kind: 'claw.deliver' }): void {
    const target = deskPositionForAgent(this.layout, directive.agentId);
    const tasksX = this.layout.tasksBoard.x;
    const trackY = this.layout.clawTrack.y;

    this.tweens.add({
      targets: this.claw,
      x: tasksX,
      duration: 600,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        const card = this.add.image(tasksX, this.layout.tasksBoard.y - 20, 'task-card').setScale(2);
        this.tweens.add({
          targets: this.claw,
          x: target.x,
          duration: 800,
          ease: 'Sine.easeInOut',
          onComplete: () => {
            this.tweens.add({
              targets: card,
              x: target.x,
              y: target.y - 30,
              duration: 400,
              onComplete: () => {
                card.destroy();
                this.ensureAgent(directive.agentId);
                this.setAgentState(directive.agentId, 'active');
              },
            });
            this.tweens.add({
              targets: this.claw,
              x: this.layout.clawTrack.idleX,
              duration: 500,
            });
          },
        });
      },
    });
    this.claw.y = trackY;
  }

  private setAgentState(agentId: string, state: 'active' | 'error'): void {
    const agent = this.ensureAgent(agentId);
    agent.stateTint = state;
    if (state === 'error') {
      agent.body.setTint(0xff6666);
    } else {
      agent.body.clearTint();
      const appearance = appearanceForAgent(agentId);
      ensureTintedTexture(this, 'character', appearance.outfitColor);
      agent.body.setTexture(ensureTintedTexture(this, 'character', appearance.outfitColor));
    }
    this.tweens.add({
      targets: agent.container,
      scaleX: 1.1,
      scaleY: 1.1,
      yoyo: true,
      duration: 200,
    });
  }

  private animateWalk(directive: SceneDirective & { kind: 'agent.walk' }): void {
    const agent = this.ensureAgent(directive.agentId);
    const target = deskPositionForAgent(this.layout, directive.targetAgentId);
    this.tweens.add({
      targets: agent.container,
      x: target.x - 20,
      y: target.y - 10,
      duration: 700,
      ease: 'Linear',
    });
  }

  private showSpeech(directive: SceneDirective & { kind: 'agent.speak' }): void {
    const agent = this.ensureAgent(directive.agentId);
    if (agent.speechBubble) {
      agent.speechBubble.destroy();
    }
    const text = (directive.content ?? '…').slice(0, 40);
    agent.speechBubble = this.add
      .text(agent.container.x, agent.container.y - 40, text, {
        fontSize: '10px',
        color: '#1a1f16',
        backgroundColor: '#ffffff',
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5);
    agent.speechBubble.setInteractive({ useHandCursor: true });
    agent.speechBubble.on('pointerdown', () => {
      this.callbacks.onDirectiveClick(directive);
    });
    this.time.delayedCall(3000, () => {
      agent.speechBubble?.destroy();
      agent.speechBubble = null;
    });
  }

  private setThinkBubble(directive: SceneDirective & { kind: 'agent.think' }): void {
    const agent = this.ensureAgent(directive.agentId);
    if (directive.phase === 'stop') {
      agent.thinkBubble?.destroy();
      agent.thinkBubble = null;
      return;
    }
    agent.thinkBubble?.destroy();
    agent.thinkBubble = this.add
      .image(agent.container.x + 20, agent.container.y - 30, 'think-bubble')
      .setScale(1.5);
    if (directive.skillName) {
      this.add
        .text(agent.container.x + 20, agent.container.y - 30, directive.skillName.slice(0, 8), {
          fontSize: '8px',
          color: '#333',
        })
        .setOrigin(0.5);
    }
  }

  private animateTube(direction: 'in' | 'out'): void {
    const pos = direction === 'in' ? this.layout.tubeIn : this.layout.tubeOut;
    const particle = this.add.circle(pos.x, pos.y, 6, direction === 'in' ? 0x6a9a6a : 0x9a6a6a);
    const targetX = direction === 'in'
      ? (this.layout.coordinatorId
        ? deskPositionForAgent(this.layout, this.layout.coordinatorId).x
        : 400)
      : pos.x + 40;
    this.tweens.add({
      targets: particle,
      x: targetX,
      y: pos.y + 20,
      alpha: 0,
      duration: 600,
      onComplete: () => particle.destroy(),
    });
  }

  private showTaskCard(directive: SceneDirective & { kind: 'task.appear' }): void {
    const existing = this.taskCards.get(directive.taskId);
    if (existing) return;
    const card = this.add
      .image(this.layout.tasksBoard.x, this.layout.tasksBoard.y - 30, 'task-card')
      .setScale(2)
      .setInteractive({ useHandCursor: true });
    card.on('pointerdown', () => {
      this.callbacks.onDirectiveClick(directive);
    });
    if (directive.title) {
      this.add
        .text(card.x, card.y, directive.title.slice(0, 12), { fontSize: '8px', color: '#1a1f16' })
        .setOrigin(0.5);
    }
    this.taskCards.set(directive.taskId, card);
    this.tweens.add({ targets: card, y: card.y - 10, yoyo: true, duration: 300 });
  }

  private trashTask(directive: SceneDirective & { kind: 'task.trash' }): void {
    const card = this.taskCards.get(directive.taskId);
    if (!card) return;
    this.tweens.add({
      targets: card,
      x: this.layout.wastebasket.x,
      y: this.layout.wastebasket.y,
      angle: 360,
      alpha: 0,
      duration: 500,
      onComplete: () => {
        card.destroy();
        this.taskCards.delete(directive.taskId);
      },
    });
  }

  private showBadge(directive: SceneDirective & { kind: 'badge' }): void {
    const badge = this.add.container(400, 50);
    const bg = this.add.image(0, 0, 'badge').setScale(1.5);
    const label = this.add.text(0, 0, directive.label.slice(0, 20), {
      fontSize: '9px',
      color: '#1a1f16',
    }).setOrigin(0.5);
    badge.add([bg, label]);
    badge.setInteractive(new Phaser.Geom.Rectangle(-40, -8, 80, 16), Phaser.Geom.Rectangle.Contains);
    badge.on('pointerdown', () => {
      this.callbacks.onDirectiveClick(directive);
    });
    this.badgeGroup.add(badge);
    this.tweens.add({
      targets: badge,
      alpha: 0,
      delay: 4000,
      duration: 500,
      onComplete: () => badge.destroy(),
    });
  }

  private directiveForAgent(agentId: string): SceneDirective | null {
    return this.lastDirectiveByAgent.get(agentId) ?? null;
  }

  private recordDirectiveAgents(directive: SceneDirective): void {
    if ('agentId' in directive && typeof directive.agentId === 'string') {
      this.lastDirectiveByAgent.set(directive.agentId, directive);
    }
    if (directive.kind === 'agent.walk') {
      this.lastDirectiveByAgent.set(directive.targetAgentId, directive);
    }
  }
}
