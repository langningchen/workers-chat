import { handleErrors } from '../utils/errors.mjs';

export class ChatRoom {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env;

        this.sessions = new Map();
        this.roomPassword = null;
        this.messages = [];
        this.messageCounter = 0;

        this.state.blockConcurrencyWhile(async () => {
            let storedPassword = await this.storage.get("roomPassword");
            if (storedPassword !== undefined) {
                this.roomPassword = storedPassword;
            }

            let history = await this.storage.list({ prefix: "msg_", limit: 1000, reverse: true });
            let msgs = [];

            for (let [key, value] of history) {
                msgs.push(value);
                let idNum = parseInt(key.split("_")[1]);
                if (idNum > this.messageCounter) {
                    this.messageCounter = idNum;
                }
            }

            msgs.sort((a, b) => a.timestamp - b.timestamp);

            while (msgs.length > 16) {
                let removed = msgs.shift();
                this.storage.delete("msg_" + removed.id.padStart(10, "0"));
            }

            this.messages = msgs;
        });

        this.state.getWebSockets().forEach((webSocket) => {
            let meta = webSocket.deserializeAttachment();
            let lastActive = Date.now();
            this.sessions.set(webSocket, { ...meta, lastActive });
            webSocket.serializeAttachment({ ...meta, lastActive });
        });

        this.lastTimestamp = 0;
        this.pingInterval = null;
        if (this.sessions.size > 0) {
            this.pingInterval = setInterval(() => this.checkTimeout(), 2000);
        }
    }

    checkTimeout() {
        if (this.sessions.size === 0) {
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }
            return;
        }
        let now = Date.now();
        this.sessions.forEach((session, ws) => {
            if (now - session.lastActive > 10000) {
                ws.close(1011, "Ping timeout");
                this.closeOrErrorHandler(ws);
            }
        });
    }

    async fetch(request) {
        return await handleErrors(request, async () => {
            let url = new URL(request.url);

            switch (url.pathname) {
                case "/websocket": {
                    if (request.headers.get("Upgrade") != "websocket") {
                        return new Response("expected websocket", { status: 400 });
                    }

                    let ip = request.headers.get("CF-Connecting-IP");
                    let pair = new WebSocketPair();

                    await this.handleSession(pair[1], ip);

                    return new Response(null, { status: 101, webSocket: pair[0] });
                }
                default:
                    return new Response("Not found", { status: 404 });
            }
        });
    }

    async handleSession(webSocket, ip) {
        this.state.acceptWebSocket(webSocket);

        let session = { lastActive: Date.now(), status: 'active', readCursor: this.messageCounter };
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), lastActive: session.lastActive, readCursor: session.readCursor });
        this.sessions.set(webSocket, session);

        if (!this.pingInterval) {
            this.pingInterval = setInterval(() => this.checkTimeout(), 2000);
        }
    }

    broadcastRoster() {
        let users = [];
        this.sessions.forEach(s => {
            if (s.name) {
                let unread = this.messageCounter - (s.readCursor || this.messageCounter);
                if (unread < 0) unread = 0;
                users.push({ name: s.name, status: s.status || 'active', unread: unread });
            }
        });
        this.broadcast({ roster: users });
    }

    async webSocketMessage(webSocket, msg) {
        try {
            let session = this.sessions.get(webSocket);
            if (session.quit) {
                webSocket.close(1011, "WebSocket broken.");
                return;
            }

            session.lastActive = Date.now();
            webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), lastActive: session.lastActive });

            if (msg === "ping") {
                webSocket.send("pong");
                return;
            }

            let data = JSON.parse(msg);

            if (data.readCursor !== undefined) {
                session.readCursor = data.readCursor;
                webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), readCursor: session.readCursor });
                this.broadcastRoster();
                return;
            }

            if (data.status && (!data.name && !data.message && !data.requestHistory && data.typing === undefined)) {
                if (session.status !== data.status) {
                    session.status = data.status;
                    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), status: session.status });
                    this.broadcastRoster();
                }
                return;
            }

            if (!session.name) {
                if (!data.name) {
                    webSocket.send(JSON.stringify({ error: "Name required." }));
                    webSocket.close(1008, "Name required.");
                    return;
                }

                if (!data.name.match(/^[A-Za-z0-9\-_]{1,32}$/)) {
                    webSocket.send(JSON.stringify({ error: "Invalid nickname. Only letters, numbers, hyphens, and underscores are allowed." }));
                    webSocket.close(1008, "Invalid nickname.");
                    return;
                }

                let providedPassword = data.password || "";

                if (this.roomPassword !== null && this.roomPassword !== providedPassword) {
                    webSocket.send(JSON.stringify({ error: "Incorrect password." }));
                    webSocket.close(1008, "Incorrect password.");
                    return;
                } else if (this.roomPassword === null && providedPassword !== "") {
                    this.roomPassword = providedPassword;
                    this.storage.put("roomPassword", this.roomPassword);
                }

                let existingWs = null;
                this.sessions.forEach((s, ws) => {
                    if (s.name === data.name) existingWs = ws;
                });

                let isTakeover = false;
                if (existingWs) {
                    let oldSession = this.sessions.get(existingWs);
                    oldSession.quit = true;
                    existingWs.close(1011, "Session taken over");
                    this.sessions.delete(existingWs);
                    isTakeover = true;
                }

                session.name = "" + data.name;
                session.status = data.status || 'active';
                session.readCursor = this.messageCounter;
                webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name, status: session.status, readCursor: session.readCursor });

                this.broadcastRoster();
                webSocket.send(JSON.stringify({ history: this.messages }));
                if (!isTakeover) {
                    this.broadcast({ joined: session.name, status: session.status, timestamp: Date.now() });
                }
                webSocket.send(JSON.stringify({ ready: true }));
                return;
            }

            if (data.typing !== undefined) {
                session.isTyping = data.typing;
                this.broadcast({ typing: { name: session.name, isTyping: session.isTyping } });
                return;
            }

            if (data.requestHistory) {
                webSocket.send(JSON.stringify({ history: this.messages }));
                return;
            }

            if (data.message !== undefined && data.message.startsWith("/nick ")) {
                let newName = data.message.substring(6).trim();
                if (newName.length > 0 && newName.length <= 32) {
                    if (!newName.match(/^[A-Za-z0-9\-_]{1,32}$/)) {
                        webSocket.send(JSON.stringify({ error: "Invalid nickname." }));
                        return;
                    }

                    let nameTaken = false;
                    this.sessions.forEach(s => {
                        if (s.name === newName) nameTaken = true;
                    });

                    if (nameTaken) {
                        webSocket.send(JSON.stringify({ error: "Nickname already in use." }));
                        return;
                    }

                    let oldName = session.name;
                    session.name = newName;
                    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });
                    this.broadcast({ nameChange: { old: oldName, new: newName }, timestamp: Date.now() });
                    this.broadcastRoster();
                }
                return;
            }

            if (data.edit) {
                let msgId = data.edit;
                let newText = data.text;

                let targetMsg = this.messages.find(m => m.id === msgId);
                if (targetMsg && targetMsg.name === session.name) {
                    targetMsg.message = "" + newText;
                    targetMsg.edited = true;
                    this.storage.put("msg_" + msgId.padStart(10, "0"), targetMsg);
                    this.broadcast({ edited: msgId, text: newText });
                }
                return;
            }

            if (data.delete) {
                let msgId = data.delete;

                let targetIndex = this.messages.findIndex(m => m.id === msgId);
                if (targetIndex !== -1 && this.messages[targetIndex].name === session.name) {
                    this.messages.splice(targetIndex, 1);
                    this.storage.delete("msg_" + msgId.padStart(10, "0"));
                    this.broadcast({ deleted: msgId });
                }
                return;
            }

            if (data.message) {
                let msgObj = { name: session.name, message: "" + data.message };

                msgObj.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
                this.lastTimestamp = msgObj.timestamp;

                this.messageCounter++;
                msgObj.id = this.messageCounter.toString();

                this.messages.push(msgObj);

                while (this.messages.length > 16) {
                    let removed = this.messages.shift();
                    this.storage.delete("msg_" + removed.id.padStart(10, "0"));
                }

                this.storage.put("msg_" + msgObj.id.padStart(10, "0"), msgObj);

                session.readCursor = this.messageCounter;
                webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), readCursor: session.readCursor });

                this.broadcast(msgObj);
                this.broadcastRoster();
            }
        } catch (err) {
            webSocket.send(JSON.stringify({ error: err.stack }));
        }
    }

    async closeOrErrorHandler(webSocket) {
        let session = this.sessions.get(webSocket) || {};
        session.quit = true;
        this.sessions.delete(webSocket);
        if (session.name) {
            this.broadcast({ quit: session.name, timestamp: Date.now() });
            this.broadcastRoster();
        }
    }

    async webSocketClose(webSocket, code, reason, wasClean) {
        this.closeOrErrorHandler(webSocket);
    }

    async webSocketError(webSocket, error) {
        this.closeOrErrorHandler(webSocket);
    }

    broadcast(message) {
        if (typeof message !== "string") {
            message = JSON.stringify(message);
        }

        let quitters = [];
        this.sessions.forEach((session, webSocket) => {
            if (session.name) {
                try {
                    webSocket.send(message);
                } catch (err) {
                    session.quit = true;
                    quitters.push(session);
                    this.sessions.delete(webSocket);
                }
            }
        });

        quitters.forEach(quitter => {
            if (quitter.name) {
                this.broadcast({ quit: quitter.name, timestamp: Date.now() });
                this.broadcastRoster();
            }
        });
    }
}
