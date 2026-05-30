export type MessageKind = 'user' | 'agent' | 'status' | 'error';

export interface Message {
  id: string;        // crypto.randomUUID() — stable React key
  kind: MessageKind;
  text: string;
  html?: string;     // Pre-rendered HTML for agent messages (server-side markdown conversion)
  timestamp?: Date;  // Display time; absent for status and error messages
}
