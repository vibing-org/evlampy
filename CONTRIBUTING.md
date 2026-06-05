# Contributing to Evlampy

Evlampy is a VS Code extension that provides a maximally simple and economical wrapper for working with LLMs.

## Codebase Map

Shared contracts:

- `src/types.ts`: It defines the `GlobalState`, `Intents` (Webview -> Host), `HostMessages` (Host -> Webview), and core data structures.

Extension Host (Backend):

- `src/extension.ts`: The entry point. Wires up the provider, commands, and the diff manager.
- `src/chatViewProvider.ts`: The Controller. Receives `Intents` from the Webview, orchestrates calls to various services, and pushes `state:update` back to the UI.
- `src/ChatSession.ts`: The SSOT for state. Manages the `GlobalState` object. Automatically handles saving history to `workspaceState` and debug-logging chats to disk.
- `src/AttachmentManager.ts`: Resolves and validates user inputs (file/folder paths) into actual file contents. Enforces limits on folder sizes.
- `src/SuggestionManager.ts`: Handles fuzzy file/folder searching for the `@` mention autocomplete.
- `src/DiffManager.ts`: Applies diff operations to the files and manages the review UI (opening/closing diff tabs).
- `src/matcher.ts`: Contains the fuzzy algorithm to find where a `<<<<<<< SEARCH` block belongs in a file.
- `src/parser.ts`: Pure functions that parse the raw LLM string into text blocks and structured `DiffOp` objects.
- `src/openrouter.ts`: LLM API client. Takes messages and yields text/reasoning deltas.
- `src/config.ts` & `src/ConfigWatcher.ts`: Reads and watches the global VS Code config and local `.evlampy/config.json` files.
- `src/prompt.ts`: Constructs the system and user prompts.
- `src/TokenTimer.ts`: Manages timeouts during LLM streaming.
- `src/WebviewHtmlProvider.ts`: Generates the initial HTML for the Webview.

Webview (Frontend):

- `media/main.ts`: Frontend thin entry point.
- `media/DOMRenderer.ts`: Pure state-to-DOM renderer. Takes `GlobalState` and updates the DOM using key-based reconciliation to avoid disrupting text selection during streaming. No state mutation happens here.
- `media/Composer.ts`: Manages the local UI state of the input area (textarea, model selectors, attachment chips, `@` suggestions). Emits `Intents` to the backend.
- `media/AutoScroller.ts`: Encapsulates the logic for keeping the chat scrolled to the bottom unless the user manually scrolls up.
- `media/style.css`: All styling, defines signle and unified design-code for the plugin.

## Architectural Principles

Adhere to these principles to prevent God objects and hidden knowledge:

- The Extension Host (Backend) is the absolute owner of the state (**Single Source of Truth**). The Webview (Frontend) is a "dumb" presentation layer. 
- The Webview does not store its own copy of the chat history, tokens, or cost. 
- The Host sends the **complete** `GlobalState` to the Webview. The Webview simply renders it.
- Webview cal only send intents. It never mutates the state directly.

## Rules for AI Agents

- **Minimize** changes.
- Write short comments only for important or unobvious logic.
- Decompose code into small methods and separate files.
- Follow the **Single Responsibility Principle** strictly.
- **Never overcomplicate**. Think about how to write the simplest code possible. Fight complexity.
