import { handleGithubRequest } from './services/github.mjs';
import { handleRoomApi } from './services/room.mjs';
import { handleErrors } from './utils/errors.mjs';

import HTML from './public/index.html';
import CSS from './public/style.css';
import APP_JS from './public/app.client.js';

export async function handleRequest(request, env) {
    return await handleErrors(request, async () => {
        let url = new URL(request.url);
        let path = url.pathname.slice(1).split('/');

        if (!path[0]) {
            return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }
        if (path[0] === "style.css") {
            return new Response(CSS, { headers: { "Content-Type": "text/css;charset=UTF-8", "Cache-Control": "max-age=31536000" } });
        }
        if (path[0] === "app.client.js") {
            return new Response(APP_JS, { headers: { "Content-Type": "application/javascript;charset=UTF-8", "Cache-Control": "max-age=31536000" } });
        }

        switch (path[0]) {
            case "api":
                return handleRoomApi(path.slice(1), request, env);
            case "upload":
                return handleGithubRequest(request, env, path);
            default:
                if (request.method === 'GET' && path[0].length === 32) {
                    return handleGithubRequest(request, env, path);
                }
                return new Response("Not found", { status: 404 });
        }
    });
}
