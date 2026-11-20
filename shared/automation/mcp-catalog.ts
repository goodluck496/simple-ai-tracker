import type { ProjectMcp } from './project-mcp.js';

export const MCP_PRESETS: {label:string; source:string; server:ProjectMcp}[] = [
  {label:'Playwright · браузер', source:'https://github.com/microsoft/playwright-mcp',
    server:{name:'playwright',command:'npx',args:['-y','@playwright/mcp@0.0.86','--headless','--isolated'],envVars:[],
      tools:['browser_navigate','browser_snapshot','browser_click','browser_take_screenshot'],roles:[]}},
  {label:'Context7 · документация', source:'https://github.com/upstash/context7',
    server:{name:'context7',url:'https://mcp.context7.com/mcp',bearerTokenEnvVar:'CONTEXT7_API_KEY',tools:['resolve-library-id','query-docs'],roles:[]}},
  {label:'GitHub · ревью', source:'https://github.com/github/github-mcp-server',
    server:{name:'github',url:'https://api.githubcopilot.com/mcp/',bearerTokenEnvVar:'GITHUB_PERSONAL_ACCESS_TOKEN',
      tools:['pull_request_read','get_file_contents'],roles:[]}},
];

export const MCP_CATALOG = [
  { name: 'Simple AI Tracker', purpose: 'Требования, план и уточнения карточки', setup: 'В Codex CLI подключается воркером для чтения.' },
  { name: 'CodeGraph', purpose: 'Навигация по коду и ревью', setup: 'Для Codex CLI нужен индекс в рабочей копии этапа.' },
  { name: 'Figma', purpose: 'Макеты и референсы', setup: 'Добавьте URL сервера, если он поддерживает выбранный способ авторизации.' },
  { name: 'Blender', purpose: 'Чтение и редактирование 3D-сцен', setup: 'Укажите stdio-сервер и обеспечьте доступ с воркера к Blender.' },
] as const;
