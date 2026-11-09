export const MCP_CATALOG = [
  { name: 'Simple AI Tracker', purpose: 'Требования, план и уточнения карточки', setup: 'В Codex CLI подключается воркером для чтения.' },
  { name: 'CodeGraph', purpose: 'Навигация по коду и ревью', setup: 'Для Codex CLI нужен индекс в рабочей копии этапа.' },
  { name: 'Figma', purpose: 'Макеты и референсы', setup: 'Официальный HTTP-сервер требует stdio-адаптера для проектного манифеста.' },
  { name: 'Playwright', purpose: 'Проверка веб-интерфейса и сценариев приёмки', setup: 'Укажите stdio-сервер в проектном манифесте.' },
  { name: 'Blender', purpose: 'Чтение и редактирование 3D-сцен', setup: 'Укажите stdio-сервер и обеспечьте доступ с воркера к Blender.' },
  { name: 'GitHub', purpose: 'Ревью pull request и чтение результатов CI', setup: 'Укажите stdio-сервер и настройте доступ к репозиторию на воркере.' },
] as const;
