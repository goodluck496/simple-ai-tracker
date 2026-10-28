# SAT-35 — Antigravity и невалидный результат SAT-352

Исследован run 702af901-d502-429b-9d16-568a17236df9 в Game1/default,
задача SAT-352 о волках. В журнале:

- npm install завершился exit 0 после подготовки worktree.
- analyst/antigravity gemini-3.8-flash-medium работал около 5 минут.
- agy.exe завершился exit 0.
- Затем worker выдал Agent must return a valid JSON verdict.

Эта ошибка возникает после успешного JSON.parse, когда отсутствуют допустимый
verdict или строковый summary. Это не доказательство отказа модели.
Исходный stdout не сохранён, stderr при успешном exit коде терялся, поэтому
точный ответ и фактическую причину конкретного запуска восстановить нельзя.
Usage Antigravity в этом запуске не измерена, нулевой она не объявляется.

Найдены дефекты интеграции: не передавалась json-schema, не читался
structured_output, пустой response заменялся целой CLI-обёрткой, а notices
stderr при exit 0 не попадали в диагностику.
Установленный agy (changelog начинается с 1.4.9) поддерживает json-schema/add-dir.
В прочитанном глобальном CLI settings.json нет permissions.allow правил.

По [официальной документации](https://antigravity.google/docs/cli/headless/)
structured_output содержит результат схемы, а headless-инструмент с запросом
разрешения может быть soft-denied с exit 0 и уведомлением stderr.
Это возможное объяснение исходного сбоя, а не подтверждённая история SAT-352.
Правила проекта, доступность MCP и разрешения команд остаются отдельными
предпосылками успешного исполнения.

Исправлено:

- Передаются --add-dir <worktree> и --json-schema .sat/outcome-schema.json.
- Читается structured_output; корректный JSON response поддержан для
  совместимости. Prose/отказ/пустой response не превращаются в pass.
- У ProcessExecutor появился callback stderr. Для Antigravity хранится
  ограниченный хвост, по нему различаются headless permission/auth ошибки.
- При отсутствии результата выводятся status, наличие structured_output,
  длина response и session ID. Тело ответа/файлов и stderr с секретами
  не публикуются в журнал; обход permissions не добавлен.
- Понятные ошибки заменяют общий JSON verdict для пустого/неполного ответа.

Проверки: 5 focused tests, полный npm test — 147 passed;
typecheck и build:server прошли. Использованы fixture executors и настоящий
локальный subprocess с stderr/exit 0, без запросов к моделям.
Глобальные permissions, настройки моделей и статусы игровой задачи не менялись.
SAT-352 автоматически не продолжалась. Новый adapter требует обновлённого
execution child worker; конфигурация/зависимости старого worktree сохранены.
