# SAT-16 — новые установки, 2026-10-27

- Пользователь установил исходный DeepSeek Harness в `E:/work/developing/soft/deepseek-harness`. CLI `apps/cli/lib/bin.js --version` сообщает `0.2.1-rc.3`.
- `package.json` требует Node >=24.9. Текущий shell — Node 22.19.0, но уже установлен `%LOCALAPPDATA%/nvm/v24.17.0/node.exe`. Глобальный Node не переключался.
- Под явным Node 24.17.0 выполнены `dsh --profile sdk --help` и `dsh --profile headless --help`. Для этих probes использовался отдельный временный DSH_HOME, пользовательские профили не изменялись. SDK stdio JSON-RPC и headless JSON/session-id поддерживаются этой установкой. Это не проверка авторизации и не модельный запуск.
- Antigravity установлен в `%LOCALAPPDATA%/agy/bin/agy.exe`, версия `1.4.8`. `agy models` успешно вернул 13 TSV-строк с точными slug и названиями. Флаг `models --help` не рекламирует JSON; используется реально проверенный TSV, без выдуманного `--json`.
- Команды agy/dsh не найдены в снимке PATH текущего shell. Поэтому worker теперь обнаруживает стандартный Windows путь agy; один resolver используется каталогом и NativeAgentRunner. Для нестандартной установки предусмотрен абсолютный `SAT_ANTIGRAVITY_PATH`; глобальные PATH/auth/permissions не меняются.
- WorkerModelCatalog теперь поддерживает Antigravity. Реальный вызов через этот класс вернул те же 13 моделей без inference. Ошибочный формат каталога отклоняется, идентификаторы не угадываются. Это завершённый первый функциональный этап SAT-16.

Проверки: 6 focused catalog tests; полный набор 120/120; typecheck, серверная и Angular-сборки прошли. Платные генерации не выполнялись, пользовательские задачи не запускались.

Остаётся DSH launch descriptor (явный Node 24 + source CLI), отдельный профиль/bridge для каталога и эффективной модели, безопасная проверка входа, затем ограниченная приёмка выполнения. Также остаются расширенный Antigravity usage/schema/session handling из общего плана. Карточка SAT-16 остаётся in_progress; наличие установленных приложений не выдаётся за завершённую интеграцию.
