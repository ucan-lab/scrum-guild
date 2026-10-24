// SPA として作る。画面はブラウザで描き、データは Hono の API から取る。
// どのページも prerender せず、adapter-static の fallback（index.html）がすべての画面を受ける
export const ssr = false;
