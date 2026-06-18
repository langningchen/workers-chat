export async function handleRoomApi(path, request, env) {
    if (path[0] !== "room") {
        return new Response("Not found", { status: 404 });
    }

    if (!path[1]) {
        if (request.method == "POST") {
            let id = env.rooms.newUniqueId();
            return new Response(id.toString(), { headers: { "Access-Control-Allow-Origin": "*" } });
        } else {
            return new Response("Method not allowed", { status: 405 });
        }
    }

    let name = path[1];
    let id;
    if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
    } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
    } else {
        return new Response("Name too long", { status: 404 });
    }

    let roomObject = env.rooms.get(id);
    let newUrl = new URL(request.url);
    newUrl.pathname = "/" + path.slice(2).join("/");

    return roomObject.fetch(newUrl, request);
}
