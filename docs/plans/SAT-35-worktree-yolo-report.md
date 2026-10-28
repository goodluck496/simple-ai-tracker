# SAT-35 — разрешённый пользователем YOLO в worktree и поток Antigravity

Пользователь явно разрешил YOLO при работе в отдельной worktree.
Antigravity получает --dangerously-skip-permissions только после проверки:
cwd — корень linked worktree, не configured repositoryPath; .git — обычный
файл; git-dir отличается от common-dir; common-dir совпадает с репозиторием;
cwd присутствует в git worktree list. Основной checkout, чужой репозиторий,
незарегистрированная копия .git отвергаются до вызова модели.
Глобальные настройки CLI не меняются.
Это проверка места запуска, а не отдельная OS-песочница файловой системы.

Реальная проверка SAT-352:

- Один новый analyst вызов gemini-3.8-flash-medium в прежней worktree.
- PID и CLI log подтверждают dangerously-skip-permissions.
- CLI написал auto-approving all tool permissions.
- За 360 секунд результат не вернулся; вызов остановлен по таймауту,
  исходники не изменены, stdout/stderr пусты, usage неизвестна.
- Native log содержит 59 записей streamGenerateContent; это не основание
  объявлять 59 завершённых задач или известную сумму токенов.
- conversation_id: b46329d3-103a-4e6b-b7e4-542c869e438d.
- Одно короткое продолжение этой сессии для сохранения накопленного плана,
  без новых инструментов, также остановлено через 120 секунд.
  Stream init подтвердил permission_mode=always-proceed; плана/usage нет.
- Платные вызовы больше не повторялись. Старый AgentRun остаётся failed,
  план в SAT-352 не прикреплён. Это не успешная приёмка задачи моделью.

Чтобы дальнейшие вызовы не были непрозрачны, адаптер переведён на
stream-json по официальному протоколу CLI. В журнале — init mode,
имена/состояния инструментов и компактная команда. text_delta, reasoning,
tool output и тела аргументов не публикуются. Терминальный result
сохраняется отдельно от обрезаемого stdout tail и передаётся парсеру схемы.

Добавлен источник antigravity-json. Per-step DONE usage учитывается
идемпотентно по step_index; повтор шага заменяет snapshot. Terminal aggregate
заменяет промежуточную сумму и не прибавляется повторно. При отсутствии
итогового usage данные помечаются partial. Worker получает onUsage во время
выполнения шага и применяет существующий бюджет; лимиты не увеличивались.
Без usage счётчик остаётся неизвестным, не нулевым.

Проверки: 150 тестов, typecheck, build:server.
Новые регрессии используют настоящие временные Git worktree и CLI fixtures:
main/foreign/fake checkout не вызывает модель; правильный linked checkout
проходит; stream fragments, повтор DONE, partial/terminal usage, секреты,
сохранение terminal result при обрезанном stdout.
Источник протокола: https://antigravity.google/docs/cli/headless/

Артефакты второго ручного запуска находятся в .sat/logs/
manual-antigravity-640c8144-9ed8-4ffb-ab6c-c4e7def368a6.
Первые выводы о runtime ограничены наблюдениями: YOLO подтверждён,
получение итогового результата Antigravity всё ещё не подтверждено.
