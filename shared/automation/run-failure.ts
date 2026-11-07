export function runFailure(text: string): { title: string; detail: string; code?: string } | undefined {
  if (/worker lease expired|tracker connection\/lease lost/i.test(text)) {
    return { title: 'Трекер потерял связь с воркером',
      detail: 'Проверьте, что служба воркера работает и подключена к трекеру. После восстановления связи продолжите текущий этап.' };
  }
  const code = /\b(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b/i.exec(text)?.[1].toUpperCase();
  if (!code) return undefined;
  const title = /TIMEOUT|TIMEDOUT/.test(code) ? 'Истекло время ожидания соединения'
    : code === 'ECONNREFUSED' ? 'Сервер отклонил соединение'
    : code === 'ECONNRESET' ? 'Соединение с сервером оборвалось'
    : 'Сетевой адрес недоступен';
  return { title, code, detail: 'Проверьте с машины воркера адрес и доступность сервиса, к которому обращался исполнитель. Для OpenCode с Ollama проверьте, что Ollama запущена и доступна по сети. Затем продолжите текущий этап.' };
}
