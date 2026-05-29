export type MessageKind = 'user' | 'agent' | 'status' | 'error';

export interface Message {
  id: string;        // crypto.randomUUID() — stable React key
  kind: MessageKind;
  text: string;
}
