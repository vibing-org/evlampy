# Evlampy

[![Marketplace Version](https://vsmarketplacebadges.dev/version/vibing-org.evlampy.svg)](https://marketplace.visualstudio.com/items?itemName=vibing-org.evlampy)
[![Installs](https://vsmarketplacebadges.dev/installs-short/vibing-org.evlampy.svg)](https://marketplace.visualstudio.com/items?itemName=vibing-org.evlampy)
[![Rating](https://vsmarketplacebadges.dev/rating-star/vibing-org.evlampy.svg)](https://marketplace.visualstudio.com/items?itemName=vibing-org.evlampy)
[![GitHub Release (Latest)](https://img.shields.io/github/v/release/vibing-org/evlampy?color=orange&label=github%20release)](https://github.com/vibing-org/evlampy/releases/latest)

<p align="right">
  <a href="https://github.com/vibing-org/evlampy/blob/main/README.md">English</a> |
  <strong>Русский</strong>
</p>

Evlampy — это расширение для VS Code, представляющее собой максимально простую и экономную оболочку для работы с LLM. 

Проект появился как альтернатива существующим ИИ-агентам (Claude Code, Codex, Cursor, Roo-Code). Главная проблема автономных агентов — они тратят **нереальное количество токенов** на самостоятельное чтение файлов, выполнение команд, правки файлов по одному и попытки решить задачу в фоне.

Evlampy принципиально лишен agentic loop, он **ван-шотит** задачу. Один запрос — один ответ. Всё. Как обычный чат с нейронкой, но гораздо удобнее. Отказ от автономности позволяет Evlampy тратить **в 10 раз меньше токенов** по сравнению с другим агентами.

## Идея

Нельзя позволять моделям делать работу, которую они делать не умеют.

Проектирование все равно выполняет разработчик. Даже если LLM нагенерила дизайн-документ, разработчик всё равно обязан потратить существенные ментальные усилия на его тщательную валидацию и вычищение нейрослопа. В итоге, он прошерстит тот же самый код, разберется в задаче и суммарно потратит не сильно меньше времени, как если бы работал вообще без агента.

- Строго **один запрос — один ответ**. Вы собираете полный контекст, отправляете его, получаете пачку диффов на ревью.
- Нет фоновой работы. Evlampy не читает файлы сам, не выполняет команды в терминале и **не пишет файлы по одному**.
- У вас полное управление контекстом: нет огромного системного промпта, ролей, MCP, slash-команд или вызова инструментов. Всё для экономии токенов.

## Использование

1. Вы описываете глобальные правила в `AGENTS.md` (или любом другом файле).
2. В чате пишете, что нужно сделать.
3. Добавляете нужные файлы или куски кода в контекст. Это делается через символ `@` в чате или шорткатом `Cmd+I` (`Ctrl+I`) прямо из редактора. Можно добавлять целые папки также через `@`.
4. Отправляете запрос.
5. Модель присылает ответ с изменениями.
6. Evlampy автоматически парсит ответ и применяет все диффы к файлам.
7. Открывается стандартный интерфейс ревью VS Code. Вы просматриваете изменения по каждому файлу, при необходимости правите руками и нажимаете Accept или Reject.

Если модель считает, что ей не хватает контекста или нужно запустить команду — она просто напишет об этом текстом. Никаких самостоятельных действий она не предпримет.

## Установка

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vibing-org.evlampy)
- [GitHub Release](https://github.com/vibing-org/evlampy/releases/latest) (VSIX)

## Настройка

Evlampy использует глобальные настройки VS Code. Чтобы прописать API-ключ и модели, откройте Command Palette (`Cmd/Ctrl+Shift+P`) и выполните: `Evlampy: Open Global Config`

Если для конкретного проекта нужны свои настройки (например, другой путь до `AGENTS.md`), выполните: `Evlampy: Override config for project`

Команда создаст локальный файл `.evlampy/config.json`.

- `userSystemPromptPath`: путь к файлу с системным промптом. Можно указать абсолютный путь или относительный от корня проекта.
- `baseURL`: адрес API.
- `apiKey`: ваш ключ доступа (поддерживает `${env:VAR}`).
- `models`: массив с названиями моделей, как у провайдера.
- `serviceTier`: укажите `"flex"` для экономии [у некоторых провайдеров](https://openrouter.ai/docs/guides/features/service-tiers).

## Демо

![Webp Demo](https://raw.githubusercontent.com/vibing-org/evlampy/main/docs/content/full-demo.webp)

## Разработка

- Настройка и отладка: Выполните `npm install`, затем нажмите `F5` в VS Code, чтобы собрать и запустить хост расширения (в новом окне).
- Тесты: Выполните `npm run test:core`.
- Сборка пакета и локальная установка:
  ```bash
  npx @vscode/vsce package
  code --install-extension evlampy-<version>.vsix
  ```
