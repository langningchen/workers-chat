import HTML from "./chat.html";

const SW_CODE = `
const wsMap = new Map();
const queueMap = new Map();
const pingMap = new Map();
const visibilityMap = new Map();

function getOrCreateWs(room, user, pass, host, proto, initialStatus) {
    if (wsMap.has(room)) {
        let ws = wsMap.get(room);
        if (ws.readyState === 0 || ws.readyState === 1) return ws;
    }

    const wssUrl = proto + '//' + host + '/api/room/' + room + '/websocket';
    const ws = new WebSocket(wssUrl);
    wsMap.set(room, ws);
    ws._stopReconnect = false;
    
    if (!queueMap.has(room)) queueMap.set(room, []);

    ws.onopen = async () => {
        ws.send(JSON.stringify({name: user, password: pass, status: initialStatus || 'background'}));
        
        const clients = await self.clients.matchAll({includeUncontrolled: true, type: 'window'});
        clients.forEach(c => c.postMessage({type: 'WS_STATUS', room: room, status: 'CONNECTED'}));
        
        if (pingMap.has(room)) clearInterval(pingMap.get(room));
        pingMap.set(room, setInterval(() => {
            if (ws.readyState === 1) ws.send("ping");
        }, 2000));
    };

    ws.onmessage = async (event) => {
        if (event.data === "pong") return;
        const data = JSON.parse(event.data);

        if (data.error) {
            if (data.error.includes("password") || data.error.includes("nickname") || data.error.includes("Invalid")) {
                ws._stopReconnect = true;
            }
        }
        
        if (data.ready) {
            ws._isReady = true;
            let queue = queueMap.get(room);
            while(queue && queue.length > 0) {
                ws.send(queue.shift());
            }
        }

        const clients = await self.clients.matchAll({includeUncontrolled: true, type: 'window'});
        clients.forEach(client => {
            client.postMessage({type: 'WS_MSG', room: room, data: event.data});
        });

        let isVisible = visibilityMap.get(room) === true;
        if (!isVisible && data.message && data.name && data.name !== user && !data.joined && !data.quit) {
            const notifications = await self.registration.getNotifications({ tag: room });
            let count = 1;
            if (notifications.length > 0) {
                const oldData = notifications[0].data;
                count = (oldData && oldData.count ? oldData.count : 0) + 1;
            }
            
            self.registration.showNotification('New Messages', {
                body: \`You have \${count} unread messages in #\${room}\`,
                icon: '/favicon.ico',
                tag: room,
                renotify: true,
                data: { room, count }
            });
        }
    };

    ws.onclose = async () => {
        ws._isReady = false;
        if (pingMap.has(room)) {
            clearInterval(pingMap.get(room));
            pingMap.delete(room);
        }
        wsMap.delete(room);
        
        const clients = await self.clients.matchAll({includeUncontrolled: true, type: 'window'});
        clients.forEach(c => c.postMessage({type: 'WS_STATUS', room: room, status: 'DISCONNECTED'}));

        if (!ws._stopReconnect) {
            setTimeout(() => {
                getOrCreateWs(room, user, pass, host, proto, 'background');
            }, 5000);
        }
    };

    ws.onerror = (err) => {
        ws._isReady = false;
    };

    return ws;
}

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
    const d = event.data;
    if (!d || !d.room) return;

    if (d.type === 'VISIBILITY') {
        visibilityMap.set(d.room, d.visible);
        const ws = wsMap.get(d.room);
        if (ws && ws.readyState === 1 && ws._isReady) {
            ws.send(JSON.stringify({status: d.visible ? 'active' : 'background'}));
        }
    } else if (d.type === 'CONNECT') {
        const ws = getOrCreateWs(d.room, d.user, d.pass, d.host, d.proto, d.status);
        if (ws.readyState === 1 && ws._isReady && d.requestHistory) {
            ws.send(JSON.stringify({requestHistory: true}));
        }
    } else if (d.type === 'WS_SEND') {
        const ws = getOrCreateWs(d.room, d.user, d.pass, d.host, d.proto, 'active');
        if (ws.readyState !== 1 || !ws._isReady) {
            queueMap.get(d.room).push(d.data);
        } else {
            ws.send(d.data);
        }
    }
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const d = event.notification.data;
    if (!d || !d.room) return;

    event.waitUntil(
        self.clients.matchAll({type: 'window'}).then(clients => {
            for (let client of clients) {
                if (client.url.includes('#' + d.room) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow('/#' + d.room);
        })
    );
});
`;

async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, { status: 500 });
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }

      switch (path[0]) {
        case "sw.js":
          return new Response(SW_CODE, { headers: { "Content-Type": "application/javascript;charset=UTF-8" } });

        case "api":
          return handleApiRequest(path.slice(1), request, env);

        case "upload": {
          if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
          const Image = await request.text();
          let array = new Uint8Array(32);
          crypto.getRandomValues(array);
          let ImageID = Array.from(array, byte => ('0' + byte.toString(16)).slice(-2)).join('').substring(0, 32);
          const ImageData = Image.replace(/^data:image\/\w+;base64,/, '');
          if (!ImageData || ImageData.length === 0) return new Response('Invalid image', { status: 400 });
          try {
            const response = await fetch(new URL('https://api.github.com/repos/' + env.GithubOwner + '/' + env.GithubRepo + '/contents/' + ImageID + '.jpeg'), {
              method: 'PUT',
              headers: {
                'Authorization': 'Bearer ' + env.GithubPAT,
                'Content-Type': 'application/json',
                'User-Agent': 'chat-image-uploader',
              },
              body: JSON.stringify({
                message: `Upload from ${request.headers.get('CF-Connecting-IP')}`,
                content: ImageData
              })
            });
            if (!response.ok) return new Response('Upload failed', { status: 500 });
            return new Response(ImageID, { headers: { 'Content-Type': 'text/plain' } });
          } catch (e) {
            return new Response('Upload failed', { status: 500 });
          }
        }

        default:
          if (request.method === 'GET' && path[0].length === 32) {
            const ImageID = path[0];
            const clientETag = request.headers.get('If-None-Match');
            const imageETag = `"${ImageID}"`;
            if (clientETag === imageETag) return new Response(null, { status: 304 });
            return await fetch(new URL('https://api.github.com/repos/' + env.GithubOwner + '/' + env.GithubRepo + '/contents/' + ImageID + '.jpeg?1=1'), {
              method: 'GET',
              headers: {
                'Authorization': 'Bearer ' + env.GithubPAT,
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'chat-image-uploader',
              },
            }).then(async (res) => {
              if (!res.ok) return new Response('Image not found', { status: 404 });
              return new Response(await res.blob(), {
                headers: {
                  'Content-Type': 'image/jpeg',
                  'Cache-Control': 'public, max-age=31536000, immutable',
                  'ETag': imageETag
                },
              });
            });
          }
          return new Response("Not found", { status: 404 });
      }
    });
  }
};

async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
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
    default:
      return new Response("Not found", { status: 404 });
  }
}

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

      if (data.status && (!data.name && !data.message && !data.requestHistory)) {
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

        let nameTaken = false;
        this.sessions.forEach(s => {
          if (s.name === data.name) nameTaken = true;
        });

        if (nameTaken) {
          webSocket.send(JSON.stringify({ error: "Nickname already in use." }));
          webSocket.close(1008, "Nickname already in use.");
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

        session.name = "" + data.name;
        session.status = data.status || 'active';
        session.readCursor = this.messageCounter;
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name, status: session.status, readCursor: session.readCursor });

        this.broadcastRoster();
        webSocket.send(JSON.stringify({ history: this.messages }));
        this.broadcast({ joined: session.name, status: session.status, timestamp: Date.now() });
        webSocket.send(JSON.stringify({ ready: true }));
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
