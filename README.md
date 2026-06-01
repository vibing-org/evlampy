# Evlampy

<p align="right">
  <strong>English</strong> |
  <a href="https://github.com/vibing-org/evlampy/blob/main/README.ru.md">Русский</a>
</p>

Evlampy is a VS Code extension that provides a maximally simple and economical wrapper for working with LLMs.

The project was created as an alternative to existing AI agents (Claude Code, Codex, Cursor, Roo-Code). The main problem with autonomous agents is that they burn an **unreal amount of tokens** on reading files themselves, executing commands, editing files one by one, and trying to solve tasks in the background.

Evlampy is fundamentally stripped of any agentic loop; it **one-shots** tasks. One request — one response. That's it. It's like a regular chat with an LLM, but much more convenient. By dropping an autonomy, Evlampy uses **10x fewer tokens** compared to other agents.

## Main Idea

You shouldn't let models do work they can't do.

System design is still done by the developer. Even if an LLM generates a design document, the developer still has to spend significant mental effort to thoroughly validate it and clean up the AI slop. Ultimately, they will comb through the same code, figure out the task, and spend roughly the same amount of time as if they worked without an agent at all.

- Strictly **one request — one response**. You gather the full context, send it, and receive a batch of diffs for review.
- No background work. Evlampy doesn't read files on its own, doesn't run terminal commands, and **doesn't write files one by one**.
- You have full control over the context: no huge system prompts, roles, MCP, slash commands, or tool calling. Everything is designed to save tokens.

## Usage Scenario

1. You describe global rules in `AGENTS.md` (or any other file).
2. You write what needs to be done in the chat.
3. You add the necessary files or code snippets to the context. This is done via the `@` symbol in the chat or with the `Cmd+I` (`Ctrl+I`) shortcut directly from the editor. You can also add entire folders via `@`.
4. Send the request.
5. The model replies with the changes.
6. Evlampy automatically parses the response and applies all diffs to the files.
7. The standard VS Code review interface opens. You review the changes for each file, edit them manually if necessary, and click Accept or Reject.

If the model thinks it lacks context or needs to run a command, it will simply tell you in plain text. It won't take any autonomous actions.

## Configuration

Evlampy uses global VS Code settings. To set your API key and models, open the Command Palette (`Cmd/Ctrl+Shift+P`) and run: `Evlampy: Open Global Config`.

If you need specific settings for a single project (e.g., a different `AGENTS.md` path), run: `Evlampy: Override config for project`.

This creates a local `.evlampy/config.json` file.

- `userSystemPromptPath`: path to your system prompt file. You can use an absolute path or a relative one from the project root.
- `baseURL`: API address.
- `apiKey`: your access key (supports `${env:VAR}`).
- `models`: array of model names, exactly as provided by the API.
- `defaultModel`: the model selected by default.
- `serviceTier`: use `"flex"` to save money [with some providers](https://openrouter.ai/docs/guides/features/service-tiers).

## Demo

![Webp Demo](docs/content/full-demo.webp)
