export class ApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export async function worldAPI(route, body) {
    const response = await fetch(route, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(16000), cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-Moneta-Request': '1' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok)
        throw new ApiError(data.error || '共享市场暂不可用', response.status);
    return data;
}
