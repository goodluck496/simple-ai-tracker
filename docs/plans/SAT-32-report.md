# SAT-32 — диагностика запуска аналитики из карточки

В сообщении enqueue были объединены отсутствие пути, пустой pipeline
и отсутствие checks для записи кода. Для analyst-only checks уже не
требовались, но общий английский текст создавал противоположное впечатление.
В подтверждённом пользователем пространстве Game1 (default) repositoryPath
был пустым. Через MCP заполнен только E:/work/developing/pet-projects/game1,
остальные настройки сравнены и сохранены. Host online, executor running.
Реальные задачи агент не запускал.

PipelinePolicy.configurationProblems используется UI и server:
отдельные русские причины для пути, выбора этапов и проверок кода.
Только аналитик не требует checks. Launch preview показывает причины
заранее и кнопку Настроить проект. Можно перейти из task scope в настройки
проекта, сохранить путь и вернуться к запуску задачи; выбранные роли
сохраняются в draft и не перезаписывают project pipeline.

Проверки:

- Focused launch-configuration.spec.ts: analyst-only без плана/checks
  принимается; отсутствие repo, pipeline и checks для developer различаются.
- Headless verify-card-launch.ts: запуск из карточки с пустым repo,
  выбор одного аналитика, отсутствие требования checks, переход/сохранение
  папки/возврат, точный analyst-only snapshot и сохранность project pipeline.
  Остальные сценарии ready/backlog/feature/child/active reuse также прошли.
- npm test: 143 passed.
- npm run build (server/web), npm run typecheck: passed.
- Финальный скриншот предупреждения в preview просмотрен.

Browser/API regression работает на синтетическом хранилище без моделей.
Исправление настроек Game1 не означает успешного выполнения реальной
задачи: пользователь повторяет запуск после обновления/переоткрытия модалки.
