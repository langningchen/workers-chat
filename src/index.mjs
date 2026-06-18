import { ChatRoom } from './durable_objects/ChatRoom.mjs';
import { handleRequest } from './router.mjs';

export default {
    async fetch(request, env) {
        return await handleRequest(request, env);
    }
};

export { ChatRoom };
