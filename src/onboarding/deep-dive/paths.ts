// paths.ts — where the deep dive's drafts are stored (#2362).
import type { DraftKind } from './prompts.js';

/** Where each draft is stored: durable working docs beside the summary, owned by no task. */
export const DRAFT_PATHS: Readonly<Record<DraftKind, string>> = {
  'working-rules': '/meetings/onboarding/deep-dive/working-rules.md',
  'time-and-priorities': '/meetings/onboarding/deep-dive/time-and-priorities.md',
  'writing-voice': '/meetings/onboarding/deep-dive/writing-voice.md',
};
