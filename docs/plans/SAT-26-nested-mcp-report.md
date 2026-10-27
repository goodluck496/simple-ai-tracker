# SAT-26: tracker MCP вложенного Codex

## Причина

SAT-10 остановился в questions: NativeAgentRunner отключал tracker MCP вместе с нерелевантными серверами. Это противоречило AGENT_INSTRUCTIONS.md, требующему чтения карточки через tracker_get_task. Docker и host MCP при этом работали.

## Исправление

Codex получает явный tracker stdio транспорт из тех же SAT_MCP_COMMAND/SAT_MCP_ARGS, что host worker, и workspace. Для локального запуска путь MCP bundle абсолютный, чтобы запуск из изолированного worktree не менял расположение сервера. Сохраняется allowlist только для чтения; lifecycle пишет worker. Чужие MCP по-прежнему отключены, CodeGraph привязан к worktree.

Инструкция handoff поясняет, что запрет чтения файлов относится к данным задач, а исходники читать разрешено. Отсутствующий work-progress.json не является блокером. Запасной CLI пример CodeGraph не использует необязательный --max-files; установленный host CLI этот флаг поддерживает, точная причина ошибки старой команды не установлена.

## Проверки

- Сфокусированные адаптеры: 3 passed; проверяются enabled tracker, command/args/env, disabled нерелевантные MCP, private CodeGraph.
- Реальный codex mcp list с конфигурацией, построенной NativeAgentRunner: trackerEnabled=true, docker exec -i simple-ai-tracker node /app/dist/server/mcp.mjs. Модель не вызывалась.
- Реальный tracker_get_task SAT-10 через MCP доступен; вопрос о недоступном подключении закрыт техническим ответом, запреты доступа не отменялись.
- Typecheck и сборки server/web прошли. Итог полного набора и запуск worker фиксируются в карточке.

SAT-10 пока не считается реализованным: это исправление транспорта, а не доказательство выполнения требований очереди.
