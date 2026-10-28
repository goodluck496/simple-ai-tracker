# SAT-20: произвольные роли и явный запуск

Заменяет ограничение v2 «team/developer». Поле executionMode больше не определяет выполнение и не сохраняется нормализатором. Pipeline — явная последовательность выбранных профилей: любые встроенные роли, повторяющиеся роли с разными моделями/инструкциями, любой порядок. Нужны непустой список, plan/предыдущий analyst перед записью, проверки при изменении кода и artifacts для visual validation.

В Team editor роль выбирается при добавлении. В Launch есть отдельные чекбоксы исполнителей, упорядоченный список с моделями и источник настроек. В очередь попадает именно этот immutable snapshot; project/task defaults сохраняются только отдельной кнопкой. Запуск из карточки сначала открывает preview, а не немедленно ставит задачу в очередь.

PipelinePolicy выводит writer/check/readonly поведение из выбранных stages. Tester выполняет configured checks; если после последней записи нет tester, проверки выполняет worker сразу после этого writer. Readonly этапы не меняют исходники. Аналитик отдельно оставляет план и ready карточку; readonly отчёт не запускает merge и не переводит карточку в фиктивно выполненную реализацию. Findings без writer завершаются отчётом без stage=-1. Стандартная декомпозиция возможна только при явно выбранном analyst/developer/tester/reviewer, с выбранными профилями; custom pipeline не получает отсутствующие роли.

Проверены комбинации analyst-only, два analyst, reviewer-only, tester/reviewer, designer-only, developer/reviewer, tester/developer и analyst/designer/reviewer; readonly findings без writer и mandatory checks. Реальный fixture worker вызывает только developer или developer/reviewer согласно выбору, ошибочные checks не проходят review. Headless UI подтверждает произвольные checkbox selections, точный snapshot очереди, отсутствие сохранения per-run выбора в defaults, reset/inheritance, неизменную геометрию и opaque footer.

Модели не вызывались. Полный набор/сборки и deployment фиксируются в карточке. Предыдущее описание двух execution modes в отчёте v2 историческое, актуальное поведение — выбранные stages.
