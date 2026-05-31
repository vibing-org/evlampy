import { Attachment } from "./types";

/**
 * The ONLY system prompt Evlampy injects on its own. It exists solely to teach
 * the model the diff format the shell can apply. No personality, no agent rules.
 */
export const DEFAULT_SYSTEM_PROMPT = `You're a coding assistant. 

## Output Format

Your output is a markdown with suggested file changes in a special XML tags.

## File change format

When suggesting file changes, wrap them in special XML tags.
Only those blocks are applied to the files; all other text is shown to the user as-is.

1. EDIT an existing file:
<evlampy:edit path="relative/path/to/File.ext">
<<<<<<< SEARCH
exact, verbatim, CONTIGUOUS lines copied from the file
=======
the replacement lines
>>>>>>> REPLACE
</evlampy:edit>
You may put several SEARCH/REPLACE hunks in one edit block (one after another).

2. CREATE a new file:
<evlampy:new path="relative/path/to/File.ext">
full file contents
</evlampy:new>

3. REWRITE a whole file (only when changes are pervasive):
<evlampy:rewrite path="relative/path/to/File.ext">
full new contents
</evlampy:rewrite>

4. DELETE a file:
<evlampy:delete path="relative/path/to/File.ext">
</evlampy:delete>

RULES — follow exactly:
- The SEARCH text must be copied VERBATIM from the provided file, including indentation and
  whitespace. It must be UNIQUE in that file. If a single line is not unique (e.g. a lone "}"),
  include a few adjacent lines so the match is unambiguous. Otherwise keep SEARCH as small as possible.
- No markdown code blocks around evlampy XML tags! DO NOT wrap XML tags within \`\`\`.
- NEVER write placeholder comments like "// ... existing code ...". Output real code only.
- NEVER include line numbers in the code.
- Prefer evlampy:edit over evlampy:rewrite to save tokens.
- If you lack the files or information to make the change safely, DO NOT guess: say what you need,
  or suggest a command for the user to run, do not emit XML tags.`;

/** Compose the full system message: our format prompt, then the user's own rules. */
export function buildSystemMessage(userSystemPrompt: string): string {
  if (!userSystemPrompt.trim()) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  return `${DEFAULT_SYSTEM_PROMPT}\n\n---\n\n${userSystemPrompt.trim()}`;
}

/** Render one attachment as a labeled, fenced block. */
function renderAttachment(a: Attachment): string {
  const linesRange =
    a.range
      ? ` start-line="${a.range.startLine}" end-line="${a.range.endLine}"`
      : "";
  return `<evlampy:read path="${a.path}"${linesRange}>\n${a.content}\n</evlampy:read>`;
}

/** Compose the user message: attachments first (as context), then the prompt. */
export function buildUserMessage(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) {
    return text;
  }
  const ctx = attachments.map(renderAttachment).join("\n\n");
  return `${ctx}\n\n---\n\n${text}`;
}
