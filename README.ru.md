> [!IMPORTANT]
> **[`opencode-dejavu`](https://github.com/WhiteBite/opencode-dejavu) переименован в [`dejavu-gates`](https://github.com/WhiteBite/dejavu-gates) — вы на новом доме.**
> Старый URL [github.com/WhiteBite/opencode-dejavu](https://github.com/WhiteBite/opencode-dejavu) навсегда редиректит сюда.
> - **Конфиг OpenCode:** `{ "plugin": ["opencode-dejavu"] }` → `{ "plugin": ["dejavu-gates"] }`
> - **git remote:** `git remote set-url origin https://github.com/WhiteBite/dejavu-gates.git`
> - **npm:** старый пакет [`opencode-dejavu`](https://www.npmjs.com/package/opencode-dejavu) объявлен устаревшим и заморожен на 2.27.0; все релизы начиная с 2.39.0 — это [`dejavu-gates`](https://www.npmjs.com/package/dejavu-gates)

<p align="center">
  <img src="logo/icon.svg" width="96" height="96" alt="логотип dejavu — строчная d с двумя янтарными эхо-штрихами">
</p>

<h1 align="center">dejavu — error gates для AI-кодинг-агентов</h1>

<p align="center"><b><a href="README.md">English</a></b> | <b>Русский</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/harnesses-10-green.svg" alt="OpenCode, Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro, Cline">
  <img src="https://img.shields.io/badge/TypeScript-Bun-black.svg" alt="TypeScript + Bun">
  <img src="https://github.com/WhiteBite/dejavu-gates/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

**Протез памяти с зубами** поверх сессий для AI-кодинг-агентов. Агенты повторяют одни и те же ошибки, потому что забывают их между сессиями, и markdown-правила это не лечат. dejavu механически детектирует повторяющиеся сбои вызовов инструментов (bash, read, edit, write, glob, grep) и промоутит их в принудительные гейты: напоминание при следующей попытке, жесткий блок при повторном нарушении в той же сессии. Один движок, много хостов: OpenCode (плагин), Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro (hook-handler CLI), Cline (встроенный плагин). TypeScript + Bun, поставляется как исходники, без шага сборки.

## Быстрый старт

```bash
npm install dejavu-gates
dejavu report
```

Тесты: `npm run test`

## Поддерживаемые харнессы

| Харнесс | Установка | Блок (pre) | Remind NOTE (post) | Примечания |
|---|---|---|---|---|
| **OpenCode** | npm plugin / source | ✅ | ✅ | полная интеграция: все каналы, repeat guard, контекст компакции |
| **Claude Code** | `install-hooks.ts` | ✅ | ✅ | аннотации через `additionalContext`; хук `SessionStart` вносит дайджест гейтов (топ enforced-гейтов) в начале сессии; хуки не несут exit codes → текстовая детекция |
| **Codex CLI** | `install-hooks.ts` | ✅ | ✅ | хуки стабильны и включены по умолчанию; Pre/PostToolUse срабатывают на каждый инструмент (matcher покрывает `Bash` + `apply_patch`); для project hooks может остаться trust prompt при первом запуске |
| **Gemini CLI** | `install-hooks.ts` | ✅ | ✅ | BeforeTool/AfterTool |
| **Cursor** | `install-hooks.ts` | ✅ | ✅ | shell events + CC-совместимые события |
| **Copilot CLI** | `install-hooks.ts` | ✅ | ✅ | семейства payload в camelCase + PascalCase |
| **Crush** | `install-hooks.ts` | ✅ | ❌ degraded | upstream имеет только PreToolUse — enforcement + общий store всё равно защищают; post-аннотаций нет |
| **Devin CLI** | `install-hooks.ts` | ✅ | ✅ | merge событий в корень `.devin/hooks.v1.json`; Claude-формат хуков также авто-импортируется из `.claude/settings.json` |
| **Kiro** | `install-hooks.ts` | ✅ | ✅ | `.kiro/hooks/dejavu-gates.json`; NOTE летит сырым stdout хука (канал контекста Kiro); только project scope |
| **Cline** | `cline plugin install --npm dejavu-gates` | ✅ | ✅ | встроенный плагин-хост (`src/cline-plugin.ts`); только SDK/CLI/Kanban — расширения VS Code и JetBrains не имеют системы плагинов; exit codes нет → текстовая детекция |
| Zed, Aider | — | ❌ | ❌ | нет hook API для перехвата вызовов инструментов — не портируемо |
| Windsurf, Amp | — | (planned) | ❌ | поверхности только с блоком / fire-and-forget; отложено, пока не появится инъекция контекста |

**Единый store — гейты путешествуют между харнессами.** Каждый хост читает и пишет один и тот же store (`<repo>/.opencode/dejavu/` + `~/.config/opencode/dejavu/`, `DEJAVU_HOME` переопределяет). Сигнатуры вызовов харнесс-нейтральны (имена инструментов и поля аргументов нормализуются до подписи), поэтому гейт, выученный в Claude Code, срабатывает в OpenCode, Cursor или где угодно еще, и наоборот.

## Как это работает

```
tool call fails  →  signature normalized (paths/numbers/hashes stripped)
                 →  pattern-key counted, sessions tracked
                 →  3 failures across 2 distinct sessions  →  gate promoted
 next attempt     →  [dejavu] REMINDER (call aborted, agent sees the correction)
 retry fails again →  same-session repeat offense → hard BLOCK on further attempts
 diagnostic cmd   →  gate stays remind-only: the call RUNS and the reminder rides
                     on the failing output as a [dejavu] NOTE (once per session)
```

Проектные решения (post-mortem существующих подходов):

- **Сначала напоминание, блок при повторе.** Чистый блок запускает гонку вооружений — агент обходит гейты (`npm` заблокирован → использует `pnpm`). Напоминание с коррекцией учит; блок зарезервирован для проигнорированных напоминаний.
- **Сообщения гейтов — учителя.** Каждое сообщение несет `CORRECTION:` (что делать вместо) и `EVIDENCE:` (N сбоев в M сессиях), а не просто запрет.
- **Только механические pattern-keys.** Никакой LLM-классификации ошибок в горячем пути — ненадежный компонент не занимается надежностью.
- **Две области действия.** Репозиторные ловушки живут в `<repo>/.opencode/dejavu/` (можно коммитить); паттерны, замеченные в 2+ проектах, — привычки агента, и переезжают в `~/.config/opencode/dejavu/`. Ни один store не видит все проекты, поэтому глобальный индекс паттернов (`index.json`) считает уникальные директории проектов на каждый key и двигает эскалацию.
- **Гейты гниют — значит, истекают.** 60 дней без рецидива — и гейт сбрасывается. Гейт, заблокировавший 10+ раз, но не убравший ошибку, получает `review: true` для ручного осмотра.
- **Метрика — recurrence-after-gate.** Ведется по каждому гейту как `recurredAfterGate`: если гейты не снижают рецидивы, весь подход неверен, и это будет видно в данных.
- **Enforcement имеет обратную связь.** Метрика действует: гейт, который продолжает падать после промоушена (3+ рецидива в 2+ сессиях, нарушивших снова после напоминания), или который упорно обходят явно (блокирующие: 3+ override `dejavu:proceed` в 2+ различных сессиях; напоминающие: 5 различных обходящих сессий, без сырого счётчика — обход гейта, который никогда не прерывает, — более слабый сигнал трения; одна упрямая/инжектированная сессия не может разоружить гейт), — это трение, а не обучение: такой гейт понижает себя до `watching` и больше не промоутится механически (`feedbackDemoted`). Человек может вернуть принуждение, выставив `status` обратно и очистив `feedbackDemoted` в `gates.json`; тогда гейт получает свежий льготный период.
- **Нет идентичности — нет зубов.** Сигнатура, чья суть целиком съедена параметризацией (`cmd <path> <str>`, `node <str>`), матчит целое семейство команд и никогда не сможет принуждать — только наблюдать. Слишком общие формы деградируют в evidence вместо наказания несвязанных вызовов.
- **Fail-open, всегда.** Hook CLI никогда не клинит хост: кривой payload, сломанный store или внутренний баг dejavu дают `{}` + exit 0. stdout несет только JSON решения; всё остальное идет в stderr.

## Установка

Предварительное условие для любого пути: [Bun](https://bun.sh) в PATH (hook-обработчики исполняют чистый TypeScript; сборки нет).

### Одна команда, любой харнесс (рекомендуется)

```bash
npx -y dejavu-gates install            # auto-detects installed harnesses, installs project-scope
npx -y dejavu-gates install --user     # user-scope (~/.claude, ~/.codex, ...)
npx -y dejavu-gates install --harness claude,cursor --yes
npx -y dejavu-gates uninstall          # removes only dejavu-managed entries, keeps your other hooks
npx -y dejavu-gates hooks --check      # drift report: ok / stale (moved clone) / missing / broken
```

Установщик идемпотентно мержится в конфиг каждого харнесса (чужие хуки и поля выживают), делает копию файла в `<config>.dejavu-bak` перед изменением, отказывается трогать непарсимые конфиги и пишет hook-команды, вызывающие CLI установленного пакета напрямую (никакого `npx` в горячем пути — хуки fires на каждый вызов инструмента). Либо поставьте пакет один раз (`npm i -g dejavu-gates` или `npm i -D dejavu-gates`) и используйте команду `dejavu` / `dejavu-gates` вместо `npx -y`.

### Нативные каналы плагинов (без npx, автообновляемые)

| Харнесс | Команда |
|---|---|
| Claude Code | `claude plugin marketplace add WhiteBite/dejavu-gates` затем `claude plugin install dejavu-gates@dejavu-marketplace` |
| Codex CLI | `codex plugin add WhiteBite/dejavu-gates` (хуки включены по умолчанию; одобрите trust prompt при первом запуске, если появится) |
| Copilot CLI | `copilot plugin install WhiteBite/dejavu-gates` |
| Cursor | IDE: `/add-plugin` → browse marketplace → dejavu-gates (или скопируйте репо в `~/.cursor/plugins/local/dejavu-gates`) |
| Gemini CLI | `gemini extensions install https://github.com/WhiteBite/dejavu-gates` |
| Crush | системы плагинов нет — используйте установщик выше или правьте `crush.json` руками |
| Devin CLI | маркетплейса плагинов нет — установщик пишет `.devin/hooks.v1.json`; Devin также авто-импортирует хуки Claude-формата из `.claude/settings.json` |
| Kiro | маркетплейса плагинов нет — установщик пишет `.kiro/hooks/dejavu-gates.json` (project scope; пользовательского пути хуков Kiro не документирует) |
| Cline | `cline plugin install --npm dejavu-gates` (или положите `src/cline-plugin.ts` в `.cline/plugins/`); только хосты SDK/CLI/Kanban |

Сопутствующий протокол реакции (`skills/dejavu/`) поставляется внутри бандла плагина и автоматически обнаруживается форматами плагинов Claude Code, Cursor и Gemini CLI.

### GitHub Packages (зеркало с авторизацией)

Каждый релиз также публикуется в GitHub Packages как `@whitebite/dejavu-gates`. GitHub Packages требует токен даже для публичных пакетов, поэтому npmjs.com выше остается рекомендованным каналом:

```ini
# .npmrc
@whitebite:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=<PAT with read:packages>
```

```bash
npm i -D @whitebite/dejavu-gates
```

### OpenCode

**npm (рекомендуется)** — OpenCode ставит его сам при старте. OpenCode V1 использует ключ `"plugin"`; V2 переименовал его в `"plugins"`:

```jsonc
// ~/.config/opencode/opencode.json (global) or opencode.json (project)
// OpenCode V1 (@opencode-ai/plugin)
{ "plugin": ["dejavu-gates"] }
```

```jsonc
// OpenCode V2 (@opencode/cli) — or run `opencode plugin add dejavu-gates`
{ "plugins": ["dejavu-gates"] }
```

**Из исходников:**

```bash
git clone https://github.com/WhiteBite/dejavu-gates ~/.config/opencode/vendor/dejavu
cd ~/.config/opencode/vendor/dejavu && bun install
```

```ts
// ~/.config/opencode/plugins/dejavu.ts
export { Dejavu } from "../vendor/dejavu/index.ts"
```

Сопутствующий skill (протокол поведения агента): скопируйте `skills/dejavu/` в `~/.config/opencode/skills/dejavu/`.
Команда статуса: скопируйте `commands/dejavu.md` в `~/.config/opencode/command/dejavu.md` (Claude Code, Cursor и Gemini CLI подхватывают ту же команду из бандла плагина автоматически: `commands/dejavu.md` для первых двух, `commands/dejavu.toml` для Gemini).

Перезапустите OpenCode. Гейты появятся сами по мере повтора сбоев — настраивать нечего.

### Вручную / из клона (все харнессы)

```bash
git clone https://github.com/WhiteBite/dejavu-gates && cd dejavu-gates && bun install
bun scripts/install-hooks.ts --harness claude            # project scope (cwd)
bun scripts/install-hooks.ts --harness claude --user     # user scope (~/.claude/...)
bun scripts/install-hooks.ts --harness codex --dry-run   # preview without writing
```

Генератор мержит hook-записи в конфиг харнесса (`.claude/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`, `.cursor/hooks.json`, `.github/hooks/dejavu.json`, `.crush/crush.json`, `.devin/hooks.v1.json`, `.kiro/hooks/dejavu-gates.json`), указывая на `bun "<clone>/src/cli.ts" <pre|post> --harness <name>`. Он идемпотентен, сохраняет остальные хуки/поля и отказывается трогать непарсимый конфиг.

Особенности харнессов:

- **Codex**: хуки — стабильная фича, включена по умолчанию; Pre/PostToolUse fires на каждый function tool с каноническими именами (`Bash` для shell, `apply_patch` для правок с алиасами матчера `Write`/`Edit`, `spawn_agent`, MCP-инструменты под плоскими именами). Matcher dejavu покрывает `Bash` и `apply_patch`; для project hooks может остаться trust prompt при первом запуске.
- **Crush**: только PreToolUse (AfterTool в upstream нет) — dejavu работает в degraded: блокирование работает, напоминания не могут аннотировать; общий store всё равно обучает Crush гейтами, выученными в других местах.
- **Devin CLI**: хуки живут в `.devin/hooks.v1.json`, где корень файла И ЕСТЬ карта событий — установщик мержит записи dejavu в него и снимает их при uninstall, чужие события выживают. Devin также авто-импортирует хуки Claude-формата из `.claude/settings.json` (`read_config_from.claude`, включено по умолчанию), поэтому установка для Claude уже гейтит и Devin-сессии. Пользовательского файла хуков не документировано — только project scope.
- **Kiro**: хуки — отдельные файлы в `.kiro/hooks/`; dejavu владеет там `dejavu-gates.json`. Kiro блокирует на любом ненулевом exit хука и инжектирует stdout успешного хука в контекст агента, поэтому напоминающий NOTE летит сырым stdout, а allow ничего не пишет. Пользовательского пути хуков Kiro не документирует — только project scope.
- **Claude Code**: `PostToolUseFailure` подключен к тому же post-обработчику; payloads не несут exit codes, поэтому детекция сбоев идет по тексту вывода (текстовый канал движка). Хук `SessionStart` вносит дайджест топ enforced-гейтов проекта (сначала blocking, затем reminding) как `additionalContext` — агент узнает гейтнутые вызовы до того, как потеряет первый на напоминании.

Ручной вызов (любой харнесс с command hooks):

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"Bash","tool_input":{"command":"deploy.sh"},"cwd":"/repo"}' \
  | bun src/cli.ts pre --harness claude --store /repo
# exit 0 + {} = allow; exit 2 + stderr = blocked with a [dejavu] message
```

## Надежность и безопасность

- **Политика блокировки** — блокирующими гейтами могут становиться только `bash`-команды, которые НЕ являются диагностикой. Диагностика и итерационные команды (tsc/eslint/mypy/pytest/phpunit/rspec/rubocop/gradle-test/`mvn test`/`dotnet test`/flutter/curl/grep, `dart run`, `go run|build|test|vet`, `cargo run|build|test|clippy`, `swift build|test`...) промоутятся в `reminding` — они аннотируют падающий вывод пометкой `[dejavu] NOTE` (раз в сессию) и никогда не блокируют и не прерывают запуск, так что итерация над тестами и сборками не наказывается. Файловые пробы (read/edit/write/glob/grep) остаются `watching`: измеряются, видны в отчетах, никогда не прерывают. `canBlock()`/`canRemind()` в `src/patterns.ts` — единственный источник правды. Сигнатуры без остаточной идентичности (см. выше) не принуждают ни на одном тире.
- **Идентичность one-liner'ов** — для `python -c` / `node -e` / `bun -e` / `php -r` / `ruby -e` / `perl -e` / `julia -e` / `lua -e` / `Rscript -e` и PowerShell `-Command` код в payload И ЕСТЬ вызов, поэтому он отпечатывается (`<code:hash>`) вместо схлопывания в `<str>`: разные скрипты никогда не делят гейт, а один и тот же падающий скрипт по-прежнему сходится. `-r` дает fingerprint только у php (у node/ruby/perl `-r` — флаг предзагрузки). Формы PowerShell покрыты — кавыченные пути exe (`& "C:\...\python.exe" -c ...`), here-string payloads, вызовы с env-префиксом (`PYTHONPATH=x python -c ...`). Легасые голые формы `-c <str>` никогда не принуждают ни на одном тире (residual-identity guard).
- **Разворачивание оберток** — `cmd /c|/k "..."` нормализуется во ВНУТРЕННЮЮ команду: key гейта, идентичность и диагностический тир видят реальный вызов вместо формы `cmd <path> <str>`, матчающей каждый запуск cmd.
- **Чистое сохранение** — терминальные управляющие символы (VT-цвета PowerShell, NUL) срезаются до того, как что-либо ляжет на диск; сигнатуры, сниппеты и коррекции никогда не несут ANSI escape'ов. Payload харнессов — внешний недоверенный ввод, и он проходит тот же барьер `sanitizeForStore()`, прежде чем что-либо персистится.
- **Вычищение секретов** — каждая сигнатура и сниппет проходят `scrubSecrets()` (паттерны OpenAI/Anthropic/AWS/GitHub/Slack/Stripe/JWT/bearer/строки подключения к БД/PEM + `root@host`) до записи на диск. Исторические данные чистит `migrate()` при init либо через `bun scripts/migrate.ts <dirs...>` (чистит и логи).
- **Штатные ненулевые exits** — exit 1 у диагностики НЕ является сбоем (это их нормальный итог «ничего не найдено / найдены проблемы»). Exit ≥ 2 считается всегда.
- **Aborted ≠ failed** — отмененные/прерванные исполнения инструментов ("Tool execution aborted") — инфраструктурный шум, и никогда не считаются сбоями.
- **Guard против долгих процессов** — ЗАПУСК dev-сервера/наблюдателя НА ПЕРВЕМ ПЛАНЕ (`npm run dev`, `next dev`, `vite`, `flask run`, `uvicorn`, `python -m http.server`, `mvn spring-boot:run`, `gradle bootRun`, …) заблокировал бы bash-вызов до его таймаута и оставил сироту-процесс. dejavu прерывает его в before-hook с напоминанием «запускай detached» (tmux / `nohup … &` / `Start-Process` / стартовый скрипт, спавнящий detached). Detached-формы (trailing `&`, `nohup`, `tmux`, `Start-Process`) и one-shots/сборки (`vite build`, `npm run build`) проходят молча; `# dejavu:proceed` разрешает осознанный запуск на переднем плане. Список стартеров намеренно консервативен (неоднозначные `node <file>`, `go run`, `dotnet run` не флабятся).
- **Guard против подавленного spawn** — компенсирующая мера для [anomalyco/opencode#29831](https://github.com/anomalyco/opencode) (удалить, когда фикс выйдет в upstream): вызов, который спавнит DETACHED демон, одновременно пипя/редиректя stdout (`… start | Out-Null`, `… start > $null`), висит навсегда — opencode завершает bash-вызов только по EOF stdio, а живой демон держит пайп открытым. Статический ограниченный список (`DETACHED_SPAWNERS`) прерывается в before-hook с коррекцией «запусти spawn голой командой (1-3 строки вывода) и опрашивай статус отдельным вызовом». Голые spawn'ы, не-spawn глаголы и редиректы только stderr (`2>`, `2>&1`) проходят; `# dejavu:proceed` обходит (логируется как warning).
- **Guard против наследуемого spawn** — второй путь утечки той же EOF-семантики, проверен эмпирически: `Start-Process -RedirectStandard*`/`-Wait` ВКЛЮЧАЕТ наследование хэндлов, поэтому спавнутый процесс получает stdio-пайпы вызова и держит их до своего выхода — демон, переживающий вызов (`-WindowStyle Hidden|Minimized` или известный серверный стартер в качестве спавнимой команды), вешает вызов навсегда, и редирект всех трех потоков НЕ помогает (голый `Start-Process` ничего не течет). Before-hook прерывает такую форму и учит голым spawn'ам (демон пишет свои логи сам) либо двухступенчатому spawn (внешний голый `Start-Process` pwsh one-liner'а, который редиректит внутри); `# dejavu:proceed` обходит (логируется).
- **Guard против orphan-job** — `Start-Job` без ожидания внутри вызова выполняется внутри PowerShell этого вызова и молча убивается, когда вызов заканчивается: «фоновая» работа, которая никогда не выживает, без единой ошибки. Before-hook прерывает это и учит паттерну detached bare-Start-Process (либо `Wait-Job`/`Receive-Job -Wait` для результатов внутри вызова); `# dejavu:proceed` обходит (логируется).
- **Содержимое файла — не вывод команды** — в OpenCode текстовые сигнатуры сбоев сканируются только для `bash`; сбои `read`/`edit`/`write` приходят исключительно из event-канала (файл со словом "TypeError" внутри — не сбой). Внешние харнессы доставляют сбои файловых инструментов через свои post hooks, где payload — текст ошибки самого инструмента, а не содержимое файла.
- **Конкурентность** — мутации gates.json идут под эксклюзивным lockfile; аппенд логов и ротация берут собственный лок; записи делаются через tmp+rename с ретраями на EPERM/EACCES/EBUSY (Windows AV/индексатор). Длинные пути NT получают префикс `\\?\`. Параллельные вызовы инструментов в ОДНОМ процессе сериализуются in-process очередью, прежде чем вообще коснуться файлового лока. Между процессами (несколько окон OpenCode или параллельные запуски hook-CLI из одного харнесса), если лок не удалось взять за 3 секунды, критическая секция деградирует в unlocked (конвейер инструментов никогда не должен виснуть) и пишет событие лога `degraded`. Временно нечитаемый store (лок AV, `EISDIR`) бросает исключение вместо парсинга как пустой, поэтому неудачное чтение никогда не даст следующему сохранению затереть настоящие гейты.
- **Безопасно для нескольких процессов** — цепочка эскалации remind→block персистится на самом гейте (`remindedSessions`/`failedSessions`), а не в памяти процесса: несколько окон, несколько харнессов и короткоживущие процессы hook-CLI над одним store видят одну и ту же цепочку. Enforcement всегда читает свежее состояние гейта под локом store.
- **Склейка почти-дубликатов** — новые сбои мержатся в существующие паттерны по нормализованному Levenshtein ≤ 0.3 с абсолютным порогом в 3 правки (заменило token Jaccard, который схлопывал все `<str>` плейсхолдеры; порог останавливает мержи вида `git push` vs `git pull`).
- **Ограниченная память** — per-session карты ограничены (50 записей на гейт) и освобождаются по окончании сессии; обработанные part ID вытесняются FIFO; TTL-экспирация и ротация логов перезапускаются каждые 6 часов в долгоживущих процессах (CLI прогоняет свои идемпотентные init-проходы на каждый запуск и флашит отложенные события лога перед выходом).
- **Миграция** — гейты вне политики блокировки автоматически перетируются (диагностика попадает в `reminding`, остальное в `watching`); уже доказанно повторяющаяся диагностика начинает напоминать сразу; проектные копии уже глобальных гейтов сливаются в глобальный гейт (evidence консолидируется, никогда не удаляется).
- **Self-healing** — каждый init сверяет store: непарсимый `gates.json` карантинится (байты сохраняются как `gates.json.corrupt-<ts>`), записи гейтов строго парсятся и механически чинятся (перевёрнутые даты меняются местами, дубликаты ключей сливаются, секреты/управляющие символы повторно санитизируются, протухший blocking понижается), непарсимые строки лога вырезаются в `log.jsonl.corrupt`, и кросс-проектный индекс сверяется. Каждый ремонт логируется событием `repaired`/`quarantined`.
- **Гейты заживают, а не только накапливаются** — dejavu видит и успехи: SUCCESS, совпавший с действующим гейтом, растит `succeededAfterGate`, и после 3 подряд гейт уходит в `watching` (логируется `healed`) — починенная команда перестаёт триггерить напоминания. Сбой сбрасывает серию. Негативный близнец: гейт, с которым агент продолжает бороться (рецидивы или явные override), понижает себя сам (логируется `demoted`) — принуждение слушает поведение в обе стороны. Третий путь: гейт, напомнивший 5+ раз без единого повторного нарушения, СВОЙ УРОК ВЫУЧИЛ — он мягко уходит на пенсию (логируется `retired-taught`), повторный промоут при новых сбоях остается возможным. Heal-aware: блокирующий гейт с живой heal-серией не прерывает первый запуск — он даёт вероятно-починенной команде пройти и блокирует только повторный сбой.
- **Авто-коррекции, без ручной работы** — промоутнутый гейт всегда приходит с механической дефолтной коррекцией, которую можно переопределить; она выбирается по семейству команд (протухшие артефакты `--check`, падающие тесты, ошибки типов, сеть, установки, сборки go/cargo/maven/dotnet/rspec/phpunit/make) либо из пойманной строки ошибки, поэтому гейт никогда не сидит "NOT TEACHING" в ожидании человека. `migrate()` добирает существующие гейты.
- **Repeat channel (только OpenCode)** — DashScope/Qwen жестко отвергает запрос, в истории которого одинаковый вызов инструмента (name + args байт-в-байт) стоит в последовательных раундах (HTTP 400), и один отказ отравляет сессию навсегда. Transform hook сканирует каждый исходящий payload stateless: вхождения после первого в серии одинаковых-последовательных получают маркер `_dejavu_repeat` (только в payload, никогда не персистится), серия, дошедшая до хвоста, получает пометку `[dejavu] REPETITION` на своем последнем tool result, и третий одинаковый вызов жестко блокируется в before-hook. Обход: `_dejavu_proceed: true` в аргументах (логируется как override). Никаких гейтов, никакого персиста, никакого промоушена — чистая гигиена payload.
- **Loop break (только OpenCode)** — модели, которые продолжают перевыпускать вызов после сообщения REPEAT STOP, получают автоматическое сообщение с ролью user, дописанное в исходящий payload (только payload, помечено `synthetic`). Ошибы заблокированных инструментов — стимул внутри цикла, который слабые модели читают как «повтори»; реплика с ролью user — единственный стимул, надежно выжимающий текстовый ответ и завершающий цикл. Инъекция срабатывает, только пока та же серия держит хвост — реальное сообщение пользователя или текстовый ответ ее заканчивают, — и логирует `loop-break` один раз на серию.

## Наблюдаемость (подручные инструменты отладки)

- Каждый `log.jsonl` получает событие `init` с `PLUGIN_VERSION`; события `detected` несут `channel` (`exit`/`text`/`event`) и сырой exit code; `reminded`/`blocked` несут `via` (`exact`/`fuzzy`/`segment`). Протухшие сессии плагина поэтому видны в данных.
- `bun scripts/doctor.ts [--repair] [projectDirs...]` — отчет одной командой по всем инвариантам, которые подразумевает модель данных: форма гейта, дубликаты ключей, временной порядок, порча вложенных токенов, blocking без evidence, нарушения политики, согласованность index↔gates, протухшие проектные копии, пропущенная эскалация, целостность логов, секреты, дрейф версий. `--repair` сначала лечит (идемпотентно), потом отчетит. `dejavu report [dirs...]` (npm bin) гоняет тот же отчет для любого харнесса, OpenCode не нужен.
- `bun scripts/analyze.ts [projectDirs...]` — сводка store: статусы, инструменты, топ паттернов.
- `dejavu lesson list` / `dejavu lesson set <key> "<one-line fix>"` — просмотр гейтов, у которых `correction` все еще машинный дефолт, и запись человеческой коррекции на существующий гейт (создавать гейты нельзя; промоут остается механическим). `lesson list --all` включает watching-гейты; `lesson set --author owner|agent` записывает автора коррекции; `lesson retire-when <key> <spec>` объявляет внешнее условие недействительности (`dep:<name>@>=<min>`, `path-present/absent:<p>`, `tag:<name>`), которое вычисляет `doctor`.
- Команда `/dejavu` (OpenCode, установлена глобально) сначала гоняет doctor, потом отчет.
- Диагностика hook CLI: выставьте `DEJAVU_DEBUG=1`, чтобы видеть строки лога движка в stderr (stdout всегда остается чистым JSON).

## Покрытие детекции

| Канал | Ловит |
|---|---|
| exit code + текст вывода (OpenCode `tool.execute.after`) | сбои bash (ненулевой exit, TS-ошибки, падения тестов, stack traces) |
| только текст вывода (post hooks внешних харнессов — exit codes там не существует) | вывод failure-формы: `error TS…`, `FAIL`, `panic:`, `[ERROR]`, PHPUnit/`FAILURES!`, `Fatal error:`, TAP `not ok`, … |
| сканирование событий `message.part.updated` (OpenCode) | сбои уровня инструментов (чтение отсутствующего файла, отклоненные правки), которые никогда не доходят до after-hook; текст ошибки параметризуется в Sentry-стиле |
| chain-segment matching | гейты срабатывают, даже когда гейтимая команда прячется в цепочках `x && gated-cmd`, обертках `cmd /c "..."` или подстановках `$(...)` / backtick |
| `experimental.chat.messages.transform` (OpenCode) | repeat channel: последовательные одинаковые вызовы инструментов санитизируются в исходящем payload (профилактика DashScope 400) + NOTE на 2-м раунде, жесткий блок на 3-м |
| companion skill | протокол поведения агента (как реагировать, когда аннотировать) |
| команда `/dejavu` | отчет о статусе: активные гейты, метрика рецидивов, флаги review |

Языковые экосистемы, покрытые детекцией сбоев: JS/TS, Python, Go, Rust, Java/Kotlin/Scala (Maven/Gradle/sbt), .NET, Ruby, PHP (PHPUnit), Dart/Flutter, C/C++, Elixir; шеллы: bash, PowerShell, cmd. Не покрыто (по замыслу): семантически равные, но синтаксически разные сбои за пределами fuzzy-матчинга (Levenshtein ≤ 0.3, ≥ 3 правки).

## Файлы данных

| Файл | Содержимое |
|---|---|
| `~/.config/opencode/dejavu/gates.json` | глобальные гейты (привычки агента) |
| `~/.config/opencode/dejavu/index.json` | кросс-проектный индекс паттернов: в каких директориях проектов замечен каждый failure key (evidence эскалации) |
| `<repo>/.opencode/dejavu/gates.json` | проектные гейты (ловушки репо) |
| `*/dejavu/log.jsonl` | каждое событие: detected, promoted, reminded, retry-allowed, blocked, override, expired, recurred-after-gate, demoted, healed, retired-healed, retired-taught, repaired, quarantined, degraded, init |
| `*/dejavu/*.corrupt*` | карантинная порча (непарсимый gates.json, вырезанные строки лога) — байты сохранены для форензики; после осмотра можно удалять |

Пути store исторические (`.opencode/`), но сам store харнесс-нейтрален — ЕГО ДЕЛЯТ ВСЕ харнессы. Оба файла редактируются человеком. Удаление объекта гейта отключает его. Правка `correction` улучшает то, что говориться агенту. Очистка `feedbackDemoted` (и возврат `status` в `blocking`/`reminding`) возвращает принуждение гейту, который поведение агента отправил на пенсию, — он получает свежий льготный период через `feedbackBaseline`.

Проектные store сами держат себя вне `git status`: init пишет самоиgnорирующий `.opencode/dejavu/.gitignore` — `gates.json` рассчитан на коммит (общие ловушки репо; внутри repo-относительные пути проектов и id сессий, без абсолютных машинных путей), рантайм-файлы (log, index, locks, tmp) игнорируются, — а `doctor --repair` выметает осиротевшие `*.tmp` и протухшие `*.lock` файлы (`--prune-corrupt=<days>` включает удаление карантинных артефактов старше возраста; по умолчанию 30 дней). Правило `.gitignore` уровня корня репо на `.opencode/` перебивает вложенный re-include — если репо игнорирует `.opencode/` в корне, поправьте ignore-правила, чтобы реально коммитить `gates.json`.

### Переопределения окружения

`DEJAVU_HOME` переноса оба store-каталога; `DEJAVU_DEBUG=1` печатает диагностику hook-CLI в stderr. Перечисленные ниже настройки enforcement можно переопределить на процесс без правки исходников — каждая читается один раз при старте и падает обратно в дефолт, если значение не целое в границах:

| Переменная | Дефолт | Границы | Эффект |
|---|---|---|---|
| `DEJAVU_TTL_DAYS` | 60 | 1–3650 | дней без рецидива до истечения гейта |
| `DEJAVU_NOISE_TTL_DAYS` | 7 | 1–365 | TTL для одноразовых паттернов (`watching`, count ≤ 1) |
| `DEJAVU_PROMOTE_COUNT` | 3 | 1–100 | сбоев, после которых bash-паттерн становится гейтом |
| `DEJAVU_PROMOTE_COUNT_PROBE` | 5 | 1–100 | сбоев, после которых probe-инструмент становится гейтом |
| `DEJAVU_PROMOTE_SESSIONS` | 2 | 1–100 | уникальных сессий, необходимых для промоута |
| `DEJAVU_HEAL_SUCCESSES` | 3 | 1–100 | последовательных успехов, отправляющих гейт на пенсию |
| `DEJAVU_DEMOTE_RECURRENCES` | 3 | 1–100 | рецидивов после гейта, понижающих его |
| `DEJAVU_DEMOTE_OVERRIDES` | 3 | 1–100 | явных обходов, понижающих блокирующий гейт |
| `DEJAVU_TAUGHT_REMINDERS` | 5 | 1–100 | напоминаний без рецидива, после которых гейт считается выученным |

## Разработка

```bash
bun install
bun run typecheck          # tsc --noEmit (index.ts, src/**, scripts/**, test/**)
bun test/smoke.ts          # OpenCode plugin behavioral suite (drives index.ts hooks)
bun test/enforce.ts        # engine characterization (harness-agnostic core)
bun test/adapters.ts       # adapter mapping + decision dialects
bun test/cli.ts            # CLI end-to-end (spawn, promotion, block/annotate, fail-open)
bun test/language-gaps.ts  # language-ecosystem coverage of patterns.ts
bun test/guards.ts         # proactive guards characterization (fire shapes, precedence, bypass)
bun test/messages.ts       # teaching-text framing (tier-truthful, data-label, correction bound)
bun test/property.ts       # seeded generator: normalization/fuzzy invariants
bun test/fuzz.ts           # mutation fuzz: no crash, no invariant break
bun test/env.ts            # DEJAVU_* env overrides: resolved tunables + promotion effect
bun run lint:ast           # ast-grep structural gates (needs ast-grep on PATH)
```

Архитектура: `src/patterns.ts` + `src/store.ts` + `src/validate.ts` (чистый движок + персист), `src/enforce.ts` + siblings (харнесс-агностичный enforcement: `enforceBefore`/`enforceAfter`/`recordEventFailure`/`cleanupSession` поверх `EnforceContext`), `src/adapters/` (маппинг payload ↔ контракт на каждый харнесс), `src/cli.ts` (точка входа hook-handler для внешних харнессов), `index.ts` (хост плагина OpenCode). Настройки — именованные константы в начале своих модулей (`src/store.ts`, `src/context.ts`, `src/before.ts`, `src/repeat.ts`, `index.ts`).

Структурные гейты живут в `.ast-grep/rules/` (гоняются `bun run lint:ast` и CI): `no-load-force-flag` запрещает `load(true)`/`loadIndex(true)`; `no-raw-gates-splice` запрещает raw splice на массивах гейтов.

## Сравнение с аналогами

Обзор ландшафта (сен 2026, проверено ~60 OSS-проектов + нативные фичи). Пространство распадается на два лагеря, которые никогда не пересекаются: **guardrail/hook движки** перехватывают и блокируют вызовы инструментов, но на каждый вызов оценивают только статические политики, написанные человеком, — никакой памяти о сбоях, ничему не учатся; **memory/learning плагины** персистят и извлекают между сессиями, но только инжектируют контекст в промпт — ни один никогда не блокирует вызов инструмента. dejavu сейчас единственный shipped-проект, замыкающий цикл механически: наблюдение сбоев → подсчет рецидивов (3× в 2 сессиях) → промоут принудительного гейта → remind/block → heal/demote поведению.

Три оси, разделяющие каждый продукт в пространстве:

| Продукт | Учит правила из наблюдаемых сбоев | Принуждает / блокирует вызовы | Механический горячий путь (без LLM) |
|---|---|---|---|
| **dejavu** | ✅ механический промоут | ✅ эскалация remind→block | ✅ |
| Cupcake · agentjail · cc-safety-net · probity · guardrails packs | ❌ политика руками человека | ✅ deny | ◐ |
| claude-mem · claude-smart · supermemory · opencode-mem · harness-memory | ◐ извлечение LLM, только инжект | ❌ | ❌ |
| sinapsis (archived) · harness-forge · projectmem · open-bias | ◐ считается или классифицируется | ❌ advisory only | ◐ |
| NeMo Guardrails · Guardrails AI · LLM gateways | ❌ | ❌ на уровне прокси | ❌ |
| Claude Code native permissions | ❌ статичный allow/deny | ◐ | ✅ |

### Чего нет ни у кого больше

- **Обучение + принуждение в одном цикле.** Policy-двики блокируют, но никогда не учатся; memory-инструменты учатся, но никогда не блокируют. Ближайшие механизмы умерли на подступах: sinapsis (подсчет вхождений, мульти-сессийный промоут, понижение даунвоутом, TTL — advisory-only, архивирован в авг 2026), harness-forge (журнал сбоев с весами уроков, но классификация LLM), projectmem (предупреждает перед повтором провалившегося подхода, без зубов).
- **Правила с отрицательной обратной связью.** Гейт, с которым агент продолжает бороться (рецидивы или явные override), понижает себя сам; команда, начавшая получаться, залечивается до пенсии. Ни одна система политик у аналогов не адаптируется к игнорированию.
- **Харнесс-нейтральная идентичность.** Сигнатуры нормализуются до хеширования, поэтому один store, общий для OpenCode/Claude/Codex/Gemini/Cursor/Copilot/Crush/Devin/Kiro/Cline, означает: гейт, выученный где угодно, срабатывает везде. Конфиги аналогов по конструкции привязаны к харнессу.
- **Операционная закалка.** Self-healing/карантинный store, doctor-отчет, вычищение секретов перед персистом, проактивные guards against зависания и сирот — в обследованном множестве никто такой поверхности не поставляет.

### Где dejavu хуже (честные пробелы)

- **Семантическая идентичность.** Два синтаксически разных вызова, решающих одну и ту же сломанную вещь (`pnpm tsc --noEmit` vs `npm run typecheck`), попадают на разные keys; fuzzy-мерж по дизайну — Levenshtein ≤ 0.3 с порогом ≥ 3 правок. LLM-driven memory-инструменты схлопывают такие варианты ценой извлечения — dejavu платит точностью за детерминизм.
- **Выразительность правил.** Гейты ключуются только по сигнатурам вызовов инструментов. Policy-двики руками человека (Rego в Cupcake/agentjail, rulebooks в cc-safety-net, `probity.config.ts`) умеют выражать произвольные условия — пути файлов, изоляция тенантов, PII, «никогда не трогать prod», — которые dejavu не может представить. dejavu сознательно не пытается быть security-песочницей; те инструменты дополняют, а не конкурируют.
- **Разговорная память.** claude-mem/claude-smart/supermemory вспоминают решения, предпочтения и историю проекта; dejavu помнит ровно одну вещь: падающие вызовы. Композируемо — они занимают ортогональные хранилища.
- **Тяга.** claude-mem (~95k★), claude-smart (~800★), abide (~400★) против молодого репо здесь.

### Смежные по названию, не конкуренты

- **ast-grep / sloppy / линтеры стиля Semgrep** — статически проверяют содержимое кода; dejavu потребляет ast-grep для гейтов собственного репо, но принуждает в рантайме на вызовах инструментов.
- **NeMo Guardrails / Guardrails AI / LLM gateways (LiteLLM, Portkey, Plano)** — патрулируют промпты и ответы на уровне прокси; конвейер инструментов агента они никогда не видят и не перехватывают.
- **Reflexion (research)** — вербальная саморефлексия в эпизодическом буфере на прогон; никогда не поставлялся как плагин кодинг-агента, ничего не принуждал.
- **post_compact_reminder** — статичный хук «перечитай AGENTS.md» после компакции; compact-хуки dejavu вместо этого несут настоящее состояние гейтов.
- **Hook SDK (cchooks, cc-hooks-ts, claude_hooks, beyondcode SDK)** — фреймворки для написания собственных хуков; dejavu — готовая политика, и его CLI говорит на тех диалектах, на которые они нацелены.
- **Нативные фичи платформ** — permissions/checkpoints Claude Code и плагины OpenCode закрывают статические половины; ни у кого нет кросс-сессионного обучения на сбоях или принуждения по рецидивам (запрос persistent-memory anthropics/claude-code#34556 закрыт без реализации). Если платформа выпустит это нативно, она поглотит нишу — следите, не предполагайте.

## Статистика

Честный ответ: dejavu не поставляет бенчмарк-цифер, и этот раздел их не выдумает. Что существует — ваш собственный store: каждый хост пишет `log.jsonl`, так что evidence локально, по каждому агенту, и аудируемо.

За все время в глобальном store одного разработчика (`~/.config/opencode/dejavu/log.jsonl`) по состоянию на 29 сен 2026 — 6574 события за 40 активных дней (21 авг – 29 сен), по 11 директориям проектов и всем харнессам, делящим этот store:

| Событие | Количество |
|---|---|
| сбои `detected` | 3931 (2431 уникальных pattern keys) |
| промоуты гейтов `promoted` | 237 событий, 211 уникальных keys |
| `recurred-after-gate` | 163 события, 76 уникальных keys |
| `blocked` | 56 |
| `override` (`dejavu:proceed`) | 383 |
| healed / retired-taught / demoted | 11 / 46 / 30 |

Если читать внимательно: 62 из 211 промоутнутых keys рецидивировали после появления своего гейта. Это не rate снижения — recurrence-after-gate есть сигнал здоровья конкретного гейта (`recurredAfterGate`), а понижения (30) плюс пенсии от залечивания/обучения (57) — это цикл, закрывающийся в обе стороны. Привычки агента одного человека за шесть недель — выборка размером один; относитесь к этому как к примеру того, как выглядят данные, а не как к доказательству.

**Померьте сами.** После N сессий реальной работы:

```bash
dejavu report            # doctor over project + global stores
bun scripts/analyze.ts   # statuses, tools, top patterns
```

или выполните `/dejavu` внутри OpenCode. Важные метрики лежат в `gates.json` и `log.jsonl`: `recurredAfterGate` на каждый гейт (пережил ли ошибку напоминание?) и события `healed` / `retired-taught` / `demoted` (гейт ушел на пенсию, потому что вы починили команду, или потому что боролся с вами?). Если ваши цифры говорят, что подход неверен, данные это покажут — в этом и смысл метрики.

## Дорожная карта

- Адаптеры Windsurf / Amp — заблокированы отсутствием пригодных поверхностей инъекции контекста (сегодня только блок); слоты адаптеров существуют
- команда отчетности recurrence-after-gate; `tool.execute.error` (issue opencode #27900) закрыт в upstream как not planned — детекция через event-канал остается поддерживаемым путем
- автопредложение ast-grep правил для статически детектируемых паттернов (гейты уровня CI репо)
- мерж кандидатов с эмбеддингами для семантических почти-дубликатов (advisory only — решение о принуждении остается механическим; закрывает пробел семантической идентичности выше)
- `dejavu share` — экспорт/merge переносимых бандлов гейтов между машинами и командами (opt-in; гейты и так харнесс-нейтральный JSON, команда делает их перенос явным)
- docs-as-code — генерировать справочник гейтов/коррекций из схемы store вместо ручного ухода за прозой, дрейфующей от `validate.ts`
- переопределения env-переменными — открыть настройки enforcement (пороги промоута, TTL, каппы) через env vars `DEJAVU_*` рядом с именованными константами, без конфига
- таблица семантического маппинга — поддерживаемый словарь синонимов (`pnpm tsc` ↔ `npm run typecheck`), питающий существующий механический fuzzy-мерж; advisory only, как и эмбеддинги

## Дисклеймер

dejavu — community-проект. Он не создан командами OpenCode, Anthropic, OpenAI, Google, Anysphere (Cursor), GitHub или Charm и с ними не связан.

## Лицензия

MIT

## Для кого это

Разработчики, которые ежедневно гоняют AI-кодинг-агентов и наблюдают одни и те же сбои в каждой новой сессии — протухший флаг, отсутствующий путь, команда, которая падает только на этой машине. Три профиля:

- **Соло-разработчики, тяжело сидящие на агентах** — гейты накапливаются из вашего собственного evidence в `log.jsonl`, поэтому принуждение соответствует вашей реальной истории сбоев, а не generic rulebook.
- **Пользователи нескольких харнессов** — один store, общий для всех поддерживаемых хостов: гейт, выученный в Claude Code, срабатывает в OpenCode, Cursor или любом другом харнессе, читающем тот же store.
- **Команды, которым нужно принуждение без рукописной политики** — гейты промоутятся механически из рецидивов (3 сбоя в 2 сессиях) и понижаются сами, когда агент перестает с ними бороться; люди правят только коррекции.

## Сценарии применения

- **Команда, валится сессия за сессией.** После 3 сбоев в 2 различных сессиях промоутится гейт; следующая попытка прерывается напоминанием с `CORRECTION:`, а повтор в той же сессии после неотработанного напоминания блокируется.
- **Падающая диагностика, которая должна продолжать работать.** `tsc`, `pytest`, `cargo test` и прочая диагностика промоутятся в `reminding` — вызов выполняется, `[dejavu] NOTE` ложится на падающий вывод раз в сессию, ничего не прерывается.
- **Повторяющиеся сбои файловых проб.** Чтения отсутствующих файлов и отклоненные правки попадают в `watching`-гейты — измеряются и видны в отчетах, никогда не прерывают.
- **Серверы на переднем плане, оставляющие сирот.** Запуски `npm run dev`, `uvicorn`, `next dev` прерываются в before-hook с коррекцией run-detached (tmux / `nohup … &`).
- **Одна привычка, каждый харнесс.** Сигнатуры нормализуются до хеширования, поэтому один и тот же падающий вызов гейтится в любом хосте, делящем store.
- **Курирование того, что говорится агенту.** `dejavu lesson list` показывает гейты, все еще на машинных дефолтных коррекциях; `lesson set` заменяет их человеческим фиксом.

## Почему это

- **Обучение и принуждение в одном цикле.** Опрос ~60 OSS-проектов в сен 2026 не нашел ни одного shipped-инструмента, который и учит правила из наблюдаемых сбоев, и блокирует вызовы инструментов — policy-двики никогда не учатся, memory-плагины никогда не блокируют.
- **Механический горячий путь.** Подсчет pattern-keys и fuzzy-мерж Levenshtein ≤ 0.3 решают каждый промоут — никакого LLM на пути сбоя.
- **Гейты отвечают поведением.** 3 рецидива после гейта или 3 явных override понижают гейт; 3 последовательных успеха залечивают его; 60 дней без рецидива снимают его.
- **Один store, 10 харнессов.** OpenCode, Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro и Cline читают и пишут одни и те же гейты.

## Примеры

Установка в конкретные харнессы и проверка проводки хуков:

```bash
npx -y dejavu-gates install --harness claude,cursor --yes
dejavu hooks --check
```

Проверка здоровья гейтов — инварианты doctor по каждому найденному store, затем вердикты рецидивов по каждому гейту:

```bash
dejavu report
dejavu report --recurrence
```

Замена машинной дефолтной коррекции гейта на человеческую (keys берутся из `lesson list`):

```bash
dejavu lesson list
dejavu lesson set <key> "run pnpm install before building"
```
