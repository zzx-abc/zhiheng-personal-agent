export const SERVICE_UNAVAILABLE = '连接不到本机服务。请双击“启动知衡.command”，保持启动终端运行，然后重试。已保存的记录仍保留在本机。';

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    // Superseded searches are intentionally aborted and should remain silent.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(SERVICE_UNAVAILABLE);
  }
}
