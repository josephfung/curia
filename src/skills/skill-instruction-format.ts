// skill-instruction-format.ts — format SKILL.md / reference blocks for prompts.
//
// Kept separate from skill-activation.ts and pin-resolution.ts to avoid a
// circular import (both call sites need the same progressive-disclosure footer).

/** Format a system-message block for a lazily activated skill's instructions. */
export function formatActivatedSkillInstructionBlock(
  skillName: string,
  instructions: string,
  opts?: { references?: readonly string[]; assets?: readonly string[] },
): string | null {
  const body = instructions.trim();
  const refs = opts?.references ?? [];
  const assets = opts?.assets ?? [];
  if (!body && refs.length === 0 && assets.length === 0) return null;

  const parts: string[] = [`[Activated skill: ${skillName}]`];
  if (body) parts.push('', body);
  if (refs.length > 0 || assets.length > 0) {
    parts.push('');
    parts.push('## Available progressive-disclosure files');
    parts.push(
      'Load a file on demand with skill-activate({ skill: "' +
        skillName +
        '", reference: "<path>" }). Prefer bare filenames from the lists below.',
    );
    if (refs.length > 0) {
      parts.push('', 'references/:');
      for (const r of refs) parts.push(`- ${r}`);
    }
    if (assets.length > 0) {
      parts.push('', 'assets/:');
      for (const a of assets) parts.push(`- ${a}`);
    }
  }
  return parts.join('\n');
}

/** Format a system-message block for a loaded skill reference/asset. */
export function formatSkillReferenceBlock(
  skillName: string,
  resourcePath: string,
  content: string,
  truncated: boolean,
): string {
  const truncNote = truncated ? '\n\n[truncated — file exceeded size cap]' : '';
  return `[Skill resource: ${skillName} → ${resourcePath}]\n\n${content}${truncNote}`;
}
