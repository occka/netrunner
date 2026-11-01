# План версии 0.8: DEVELOPER как полноценная IDE, звук, датчики, горячие клавиши

Рабочий план для следующей сессии Claude. Его можно выполнить от начала до конца без участия пользователя. Пользователь нужен **один раз** — сказать «релиз» в конце (это его постоянное правило). Ветка уже создана: `release/0.8.0` (локальная, от `main` после v0.7.0).

---

## 0. Режим работы (прочитать первым)

**Что уже есть** (не переделывать):
- DEVELOPER: Monaco, проводник проекта, вкладки, терминалы ConPTY, Run file, определение тулчейнов, панель Git (status, stage/unstage, discard, commit, ветки, checkout, pull, push, log, diff, init, clone), NEURAL-предложения в виде diff.
- GITHUB: токен, репозитории, PR и issues (список), просмотр кода и веток, поиск локальных клонов, «Open in Developer» на текущем файле.

**Правила сессии без пользователя:**
1. Разработка ведётся только в `release/0.8.0`; коммит после каждого пункта. Перед коммитом: `npm run typecheck`, `npm test`, `cargo test`, `cargo clippy --all-targets` — всё должно быть зелёным.
2. **Шаг 0.1 — dev рядом с установленной программой.** Сейчас dev-сборку нельзя запустить, пока открыта установленная NETRUNNER: блокировку держит single-instance, а закрыть программу пользователя авто-режим не даёт. Поэтому в `lib.rs` плагин `tauri_plugin_single_instance` и глобальную горячую клавишу нужно подключать только при `!cfg!(debug_assertions)`, а в dev использовать другую комбинацию (например Ctrl+Alt+Shift+O). Иконку трея в dev подписывать «NETRUNNER DEV». Данные dev и так лежат отдельно (`<appdata>\com.netrunner.app\dev\`, см. `lib.rs` `data_dirs`). Без этого шага все проверки интерфейса упрутся в пользователя.
3. Реальную базу пользователя (`%APPDATA%\com.netrunner.app\netrunner.db`) **никогда** не трогать. После dev-запусков проверять её заголовок (user_version, байт 60) через `\\localhost\C$\...`.
4. Автоматизации в dev выключены. Если нужен `NETRUNNER_DEV_AUTOMATION=1`, сначала выключить в dev-базе правила пользователя с триггером `netrunner_start` (PowerUP → ThrottleStop, VPN → Happ).
5. Проверка интерфейса — скриншотами через помощник `ui.ps1` (list/focus/shot/crop/click/drag/wheel/type через user32). Его надо пересоздать в scratchpad: старый scratchpad не сохраняется.
6. Конфиги правьте через Python (PowerShell 5.1 добавляет BOM и портит UTF-8); heredoc в Bash со сложными кавычками ломается — писать скрипт в файл.
7. Ничего, что меняет систему пользователя (громкость, устройство по умолчанию, план питания), не оставлять изменённым: проверять «установить то же значение, что сейчас» или вернуть исходное сразу после проверки.
8. Миграции нумеровать с **0013**. Каждая — с тестом на перенос существующих данных, если трогает старые таблицы.
9. Документацию (README, ARCHITECTURE, DEVELOPMENT, SECURITY, ROADMAP) обновлять в том же коммите, что и функцию.

**Порядок работы** (по зависимостям и ценности): 0.1 → 1 (DEVELOPER) → 2 (связь с GitHub) → 3 (звук) → 4 (Quick Access по профилям и горячие клавиши) → 5 (датчики) → 6 (хвосты 0.7) → 7 (релизная подготовка).

---

## 1. DEVELOPER — лучшая универсальная среда разработки

Цель: любой язык открывается с подсветкой. Для языков с установленным language server работают ошибки в реальном времени, автодополнение, подсказки, переход к определению, переименование, форматирование и быстрые исправления. Проект можно запускать и отлаживать.

### 1.1 LSP-мост в Rust (`src-tauri/src/dev/lsp/`)
- `process.rs`: запуск language server как дочернего процесса (stdio, без окна: `CREATE_NO_WINDOW`), один сервер на пару «язык + корень проекта», ленивый старт при открытии первого файла языка, остановка через 10 минут без открытых файлов, перезапуск при падении (не больше 3 раз за 5 минут, потом ошибка в статус-баре).
- `jsonrpc.rs`: кадрирование `Content-Length` (чтение и запись), сопоставление id запросов и ответов, таймауты (completion 2 с, остальное 10 с), отмена (`$/cancelRequest`).
- `bridge.rs`: команды Tauri `lsp_open(path)`, `lsp_change(path, version, text)`, `lsp_close`, `lsp_request(server, method, params)`; уведомления сервера (`publishDiagnostics`, `window/logMessage`, `$/progress`) идут в UI через Tauri `Channel`. Пути файлов проверять как в `dev/workspace.rs` (только внутри открытых корней).
- `initialize`: передавать `rootUri`, `workspaceFolders` и capabilities для completion (с snippets), hover (markdown), signatureHelp, definition, references, documentSymbol, rename (prepare), formatting и rangeFormatting, codeAction (quickfix), semanticTokens (если сервер умеет), inlayHint.
- Тесты: кадрирование (разрезанные и склеенные сообщения), сопоставление id, конвертация позиций UTF-16 ↔ Monaco, фейковый сервер (маленький Rust-бинарь в `tests/` или эхо-скрипт) для initialize, didOpen и publishDiagnostics. Smoke-тест с настоящим `rust-analyzer`, если он установлен (иначе пропуск).

### 1.2 Реестр language servers (`dev/lsp/registry.rs`)
Для каждого языка: расширения, команды поиска (PATH, типичные папки, `node_modules/.bin` проекта, `rustup which`), аргументы и команда установки.

| Язык | Сервер | Установка (в видимой консоли, после подтверждения) |
|---|---|---|
| TypeScript / JavaScript | typescript-language-server | `npm i -g typescript typescript-language-server` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| Python | pyright (pyright-langserver) | `npm i -g pyright` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| C / C++ | clangd | `winget install LLVM.LLVM` |
| C# | csharp-ls | `dotnet tool install -g csharp-ls` |
| Java | jdtls | ссылка на скачивание и выбор папки |
| HTML / CSS / JSON | vscode-langservers-extracted | `npm i -g vscode-langservers-extracted` |
| YAML | yaml-language-server | `npm i -g yaml-language-server` |
| Lua | lua-language-server | `winget install LuaLS.lua-language-server` |
| Bash | bash-language-server | `npm i -g bash-language-server` |
| PHP | intelephense | `npm i -g intelephense` |
| Markdown | marksman | `winget install Artempyanykh.Marksman` |
| TOML | taplo | `npm i -g @taplo/cli` |
| Kotlin, Ruby, Zig, Dart | kotlin-language-server, solargraph, zls, dart language-server | по документации каждого |

- Панель **Languages** в DEVELOPER (во вкладке Tools): для каждого языка — найден ли сервер, его версия, кнопка «Install» (запуск команды в видимой консоли, как Run file; никогда не скрыто), «Locate…» (свой путь, настройка `developer.lsp.<lang>.path`) и «Disable».
- Если сервера нет, ничего не ломается: работают подсветка Monaco и встроенные TS/JSON/CSS/HTML-воркеры, а в статус-баре написано «no language server — Install».

### 1.3 Фронтенд LSP (`src/modules/developer/lsp/`)
- Свой лёгкий клиент поверх Monaco, без `monaco-languageclient` (он тянет vscode-api на десятки МБ). Регистрировать провайдеры: completion (с resolve и сниппетами), hover, signatureHelp, definition (в том числе открытие файла и переход к позиции), references (панель результатов), documentSymbol (outline и breadcrumbs), rename, formatting (Shift+Alt+F и «Format on save»), codeAction (лампочка), inlayHints, semantic tokens.
- Diagnostics: `publishDiagnostics` → `monaco.editor.setModelMarkers`; подчёркивания, подсказки и счётчики ошибок и предупреждений в статус-баре.
- Синхронизация: `didOpen` при открытии вкладки, `didChange` (полный текст, debounce 150 мс), `didSave`, `didClose`.

### 1.4 Панель Problems и поиск
- **Problems**: все диагностики по проекту, группы по файлам, фильтр ошибки/предупреждения, клик ведёт к строке. Туда же попадают ошибки сборки из задач (1.6).
- **Поиск по проекту** (Ctrl+Shift+F): бэкенд на крейтах `ignore` (учитывает .gitignore) и `grep-searcher` (или `regex` с ограничениями: 2000 совпадений, 8 с), опции regex, учёт регистра, целое слово, маска файлов. **Замена по проекту** с предпросмотром и подтверждением, запись через атомарную запись workspace.
- **Go to file** (Ctrl+P): нечёткий поиск по файлам проекта (индекс в памяти, обновление по событиям). **Go to symbol** (Ctrl+Shift+O) через documentSymbol.

### 1.5 Редактор
- Разделение редактора на 2 группы (вертикально), перетаскивание вкладок между группами.
- Вкладки и позиции курсора восстанавливаются после перезапуска (настройка `developer.session`).
- Настройки редактора в Settings: шрифт, размер, табы и пробелы, перенос строк, миниатюра, format on save, auto save (off/afterDelay/onFocusChange), trim trailing whitespace, тема Monaco из темы NETRUNNER (уже есть).
- Обнаружение `.editorconfig`.
- Сравнение двух любых файлов (Compare with…).

### 1.6 Запуск и задачи
- Конфигурации запуска для каждого проекта (`.netrunner/launch.json` в проекте, или автоопределение): npm scripts из `package.json`, `cargo run/test/build`, `python <file>`/`pytest`, `go run/test`, `dotnet run/test`, maven и gradle, `make`.
- Задачи запускаются в терминале DEVELOPER; problem matchers (rustc, tsc, eslint, gcc/clang, python traceback, go) превращают вывод в записи Problems с переходом к строке.
- Кнопки Run ▶ и Test в заголовке, выбор конфигурации.

### 1.7 Отладка (DAP)
- `dev/dap/`: клиент Debug Adapter Protocol (тот же JSON-RPC, другое кадрирование не нужно — тоже Content-Length).
- Адаптеры в первую очередь: **debugpy** (Python, `pip install debugpy`), **js-debug** / node inspector (Node), **codelldb** (Rust и C++, скачивание VSIX-архива адаптера с GitHub releases vadimcn/codelldb — только по кнопке и с подтверждением), **delve** (Go, `dlv dap`).
- UI: точки останова в гутере (в том числе условные), панели Variables, Watch, Call Stack, Breakpoints, Debug Console; кнопки continue, step over/into/out, restart, stop (F5/F10/F11/Shift+F11), подсветка текущей строки. Режим DEBUG в DEVELOPER уже есть как заглушка — заменить на настоящий.
- Тесты: кадрирование и конечный автомат сессии на фейковом адаптере.

### 1.8 Git прямо в редакторе
- Отметки изменений в гутере (добавлено/изменено/удалено относительно HEAD), просмотр и откат изменённого фрагмента (hunk), stage фрагмента.
- Inline blame текущей строки (автор, дата, сообщение) и полный blame файла.
- Разрешение конфликтов слияния: подсветка блоков `<<<<<<<`, кнопки «Accept current / incoming / both».
- Stash (save/apply/pop/list), amend последнего коммита, график истории (простая ветвящаяся линия по `git log --graph`), сравнение веток, cherry-pick из истории.
- Всё через `git` CLI, как сейчас; опасные операции (discard, reset, force) — с подтверждением на бэкенде.

### 1.9 NEURAL в коде (по желанию, в конце пункта 1)
- «Explain / Fix with NEURAL» для выделения и для ошибки под курсором: текст ошибки и фрагмент прикладываются явно, результат приходит как предложение-diff (механизм уже есть). Ничего не отправляется без нажатия.

**Готово, когда:** открыт проект на Rust и TypeScript — ошибки подчёркиваются, Problems показывает их, автодополнение и переход к определению работают, Rename меняет символ во всех файлах, Format on save работает, `cargo test`/`npm test` запускаются из Run и ошибки компилятора кликабельны, точка останова в Python-скрипте останавливает выполнение и показывает переменные.

---

## 2. Связь кода с GitHub (DEVELOPER ↔ GITHUB)

Сейчас уже есть: clone, push/pull, просмотр репозитория и открытие в DEVELOPER. Добавить:
- **Publish to GitHub**: для локального проекта без remote — создать репозиторий (публичный или приватный, имя, описание) через API, добавить `origin`, сделать push. С подтверждением, потому что это публикация.
- **Create Pull Request** из текущей ветки: заголовок и описание (по умолчанию из коммитов), base-ветка, черновик; после создания ссылка на PR.
- **Панель Pull Requests в DEVELOPER** для репозитория открытого проекта: список, статус проверок CI (checks API), checkout ветки PR, просмотр diff PR (изменённые файлы и diff-редактор Monaco), комментарии к PR (чтение; написание — с подтверждением).
- **Issues → ветка**: «Start work» создаёт ветку `issue-<N>-<slug>` и переключает на неё.
- **Статус CI текущей ветки** в статус-баре DEVELOPER (зелёный, красный или в процессе; клик — список проверок со ссылками).
- **Open on GitHub / Copy permalink** для текущего файла и строки (из контекстного меню редактора).
- Токену нужны права: Contents RW, Pull requests RW, Issues RW, Checks R, Metadata R. Обновить текст в Connect GitHub; если прав не хватает, показывать понятную ошибку (403) с подсказкой.

**Готово, когда:** публикация проекта и создание PR проверены на локальном bare-репозитории (push) и юнит-тестами формирования API-запросов (без создания чего-либо на GitHub от имени пользователя: новые репозитории и PR — только с его согласия). Чтение реальных данных (список PR, статус CI для `occka/netrunner`) проверено вживую.

---

## 3. Звук (модуль SYSTEM → Audio и виджет)
- Список устройств вывода и ввода (Core Audio `IMMDeviceEnumerator`): имя, по умолчанию ли, громкость, mute, уровень сигнала (peak meter, только пока вкладка открыта).
- Громкость и mute устройства (`IAudioEndpointVolume`).
- **Смена устройства по умолчанию**: официального API нет; используется широко применяемый `IPolicyConfig` (недокументированный). Обернуть в `Result`; если интерфейс недоступен — кнопка «Open Windows sound settings» (`ms-settings:sound`). В SECURITY.md честно отметить, что это недокументированный интерфейс.
- **Громкость по приложениям**: `IAudioSessionManager2` → сессии (процесс, имя, иконка, громкость, mute), изменение через `ISimpleAudioVolume`.
- Виджет **Audio Mixer** (устройство, общая громкость, топ-сессии), работает и как оверлей.
- Действия автоматизации: «Set output device», «Set app volume» (`set_volume` уже есть).
- Проверка без вмешательства: прочитать текущее значение и записать его же; для mute — переключить и сразу вернуть.

## 4. Quick Access по профилям и горячие клавиши
- Миграция 0013: `quick_access.profile_id` (NULL = во всех профилях), как у оверлеев. Фильтр по профилю в QUICK ACCESS и в виджете Quick Access; переключатель «All profiles / this profile» для каждой записи.
- Миграция 0014: `quick_access.hotkey` (например `Ctrl+Alt+1`). Регистрация через `tauri-plugin-global-shortcut` при старте и при изменении; запуск записи по горячей клавише (с теми же правилами подтверждения команд).
- **Редактор горячих клавиш** в Settings: таблица всех клавиш NETRUNNER (Ctrl+K, Ctrl+I, Ctrl+Alt+O, клавиши записей), запись комбинации нажатием, проверка конфликтов (внутренних и «занято другой программой» — ошибка регистрации), сброс к умолчаниям.
- Тесты: разбор и нормализация комбинаций, конфликты, перенос данных миграцией.

## 5. Датчики через HWiNFO (по желанию пользователя, выключено по умолчанию)
- Настройка `sensors.hwinfo`: читать общую память HWiNFO (`Global\HWiNFO_SENS_SM2`, нужен включённый в HWiNFO «Shared Memory Support»; без прав администратора).
- Парсер заголовка, сенсоров и показаний (версии 2+), только чтение, безопасная обработка битых данных.
- Thermal Monitor и System Overview показывают температуры CPU и GPU и обороты вентиляторов, если источник включён; иначе — как сейчас, честное «unavailable».
- Тест парсера на записанном образце памяти (сгенерировать бинарный фикстур в тесте).

## 6. Хвосты 0.7 (проверить вживую, в dev, с `NETRUNNER_DEV_AUTOMATION=1`, после пункта 4 из раздела 0)
- Триггеры: «At a time of day» (на минуту вперёд), «Every N minutes» (1 мин), «New file in a folder» (временная папка в scratchpad), «BROWSER download finished» (скачать маленький файл в dev BROWSER), «Game starts/closes» (своя игра на charmap.exe), «Power source» и «Power plan» (план — переключить на текущий же нельзя, значит, только юнит-тесты; без изменений системы), «Network up/down» (только юнит-тесты).
- Действие «Set volume» — записать текущую громкость.
- Найденные баги исправить, тесты дополнить.

## 7. Релизная подготовка (без пользователя)
1. README, ARCHITECTURE, DEVELOPMENT, SECURITY, ROADMAP (отметить ✅ в 0.8; в разделе DEVELOPER убрать «LSP/debugger planned»; в `app/modules.ts` обновить `planned` у DEVELOPER).
2. Версия 0.8.0 в `tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml` — через Python, без BOM; `npm install --package-lock-only`.
3. Все проверки; размер бандла (Monaco и LSP-клиент должны грузиться лениво с DEVELOPER).
4. Обновить память (`netrunner-project-state.md`).
5. Написать пользователю итог: что сделано, что проверено вживую, что только тестами, и спросить «Выпускать релиз 0.8.0?».
6. По слову «релиз»: push `release/0.8.0` → PR → merge → тег `v0.8.0` на main → дождаться CI (workflow публикует в `occka/netrunner-releases`) → проверить, что `latest.json` = 0.8.0 и есть ключ `windows-x86_64-nsis`. Если CI упадёт на публикации — проверить, не истёк ли секрет `RELEASES_TOKEN` (тогда это единственное, что нужно от пользователя).

---

## Риски и решения
- **Размер**: если что-то не помещается в одну версию, порядок важности такой: LSP с диагностикой и автодополнением (1.1–1.4) → GitHub-связь (2) → Run/Problems (1.6) → Git в редакторе (1.8) → звук (3) → горячие клавиши (4) → отладка (1.7) → датчики (5). Отладку и датчики можно перенести в 0.9, отметив это в ROADMAP.
- **Language servers пользователя не установлены**: функции деградируют мягко, кнопки Install запускают официальные команды в видимой консоли только по нажатию пользователя; сам Claude ничего не устанавливает в систему.
- **Недокументированный IPolicyConfig**: при ошибке — откат на открытие системных настроек.
- **Сеть/GitHub API**: все вызовы с таймаутами; без токена функции GitHub скрыты, DEVELOPER работает локально.
