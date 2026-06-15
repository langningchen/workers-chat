// This is the Edge Chat Demo Worker, built using Durable Objects!

import HTML from "./chat.html";

// =======================================================================================
// Service Worker 代码，用于提供即使页面关闭时的后台连接保持与消息弹出通知 / 快捷回复能力
const SW_CODE = `
const wsMap = new Map();
const queueMap = new Map();
const pingMap = new Map();

function getOrCreateWs(room, user, pass, host, proto) {
    if (wsMap.has(room)) {
        let ws = wsMap.get(room);
        if (ws.readyState === 0 || ws.readyState === 1) return ws;
    }

    const wssUrl = proto + '//' + host + '/api/room/' + room + '/websocket';
    const ws = new WebSocket(wssUrl);
    wsMap.set(room, ws);
    
    if (!queueMap.has(room)) queueMap.set(room, []);

    ws.onopen = () => {
        ws.send(JSON.stringify({name: user, password: pass}));
        if (pingMap.has(room)) clearInterval(pingMap.get(room));
        pingMap.set(room, setInterval(() => {
            if (ws.readyState === 1) ws.send("ping");
        }, 2000));
    };

    ws.onmessage = async (event) => {
        if (event.data === "pong") return;
        const data = JSON.parse(event.data);
        
        if (data.ready) {
            ws._isReady = true;
            let queue = queueMap.get(room);
            while(queue && queue.length > 0) {
                ws.send(queue.shift());
            }
        }

        const clients = await self.clients.matchAll({includeUncontrolled: true, type: 'window'});
        let hasVisibleClient = false;
        clients.forEach(client => {
            client.postMessage({type: 'WS_MSG', room: room, data: event.data});
            if (client.visibilityState === 'visible' && client.url.includes('#' + room)) {
                hasVisibleClient = true;
            }
        });

        // 页面不在前台展示时推送通知，忽略系统消息
        if (!hasVisibleClient && data.message && data.name && data.name !== user && !data.joined && !data.quit) {
            self.registration.showNotification(data.name + ' in #' + room, {
                body: data.message,
                icon: '/favicon.ico',
                tag: room,
                renotify: true,
                data: { room, user, pass, host, proto },
                actions: [
                    {action: 'reply', title: 'Reply', type: 'text'}
                ]
            });
        }
    };

    ws.onclose = () => {
        ws._isReady = false;
        if (pingMap.has(room)) {
            clearInterval(pingMap.get(room));
            pingMap.delete(room);
        }
        wsMap.delete(room);
        
        // 当断开时，尝试在后台自发重连，尽量保活 SW WebSocket
        setTimeout(() => {
            getOrCreateWs(room, user, pass, host, proto);
        }, 5000);
    };

    ws.onerror = () => {
        ws._isReady = false;
    };

    return ws;
}

self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
    const d = event.data;
    if (!d || !d.room) return;

    if (d.type === 'CONNECT') {
        const ws = getOrCreateWs(d.room, d.user, d.pass, d.host, d.proto);
        if (ws.readyState === 1 && ws._isReady && d.requestHistory) {
            ws.send(JSON.stringify({requestHistory: true}));
        }
    } else if (d.type === 'WS_SEND') {
        const ws = getOrCreateWs(d.room, d.user, d.pass, d.host, d.proto);
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

    if (event.action === 'reply') {
        const replyText = event.reply;
        if (replyText) {
            // 使用 event.waitUntil 包装 Promise，确保发送完成前浏览器不会中止 SW 进程
            event.waitUntil(new Promise((resolve) => {
                const ws = getOrCreateWs(d.room, d.user, d.pass, d.host, d.proto);
                const msgStr = JSON.stringify({message: replyText});
                
                if (ws.readyState === 1 && ws._isReady) {
                    ws.send(msgStr);
                    resolve();
                } else {
                    if (!queueMap.has(d.room)) queueMap.set(d.room, []);
                    queueMap.get(d.room).push(msgStr);
                    
                    // 轮询等待连接就绪后队列被消费
                    let attempts = 0;
                    let check = setInterval(() => {
                        attempts++;
                        if (ws.readyState === 1 && ws._isReady) {
                            clearInterval(check);
                            setTimeout(resolve, 500); // 给时间让队列发出
                        } else if (ws.readyState === 3 || attempts > 20) { // 超过10秒放弃
                            clearInterval(check);
                            resolve();
                        }
                    }, 500);
                }
            }));
        }
    } else {
        event.waitUntil(
            self.clients.matchAll({type: 'window'}).then(clients => {
                for (let client of clients) {
                    if (client.url.includes('#' + d.room) && 'focus' in client) return client.focus();
                }
                if (self.clients.openWindow) return self.clients.openWindow('/#' + d.room);
            })
        );
    }
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
                'User-Agent': 'langningchen-image',
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
                'User-Agent': 'langningchen-image',
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

      // Load messages history
      let history = await this.storage.list({ prefix: "msg_", limit: 1000, reverse: true });
      let msgs = [];
      for (let [key, value] of history) {
        msgs.push(value);
        let idNum = parseInt(key.split("_")[1]);
        if (idNum > this.messageCounter) {
          this.messageCounter = idNum;
        }
      }
      // sort by timestamp ascending
      msgs.sort((a, b) => a.timestamp - b.timestamp);
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
      // Kick offline if no message/ping received for 10s
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

    let session = { lastActive: Date.now() };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), lastActive: session.lastActive });
    this.sessions.set(webSocket, session);

    if (!this.pingInterval) {
      this.pingInterval = setInterval(() => this.checkTimeout(), 2000);
    }
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      // Update last active time for timeout tracking
      session.lastActive = Date.now();
      webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), lastActive: session.lastActive });

      if (msg === "ping") {
        webSocket.send("pong");
        return;
      }

      let data = JSON.parse(msg);

      if (!session.name) {
        if (!data.name) {
          webSocket.send(JSON.stringify({ error: "Name required." }));
          webSocket.close(1008, "Name required.");
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
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({ error: "Name too long." }));
          webSocket.close(1009, "Name too long.");
          return;
        }

        // Send Current Roster ONLY to the newly joined user
        let users = [];
        this.sessions.forEach(s => { if (s.name) users.push(s.name); });
        webSocket.send(JSON.stringify({ roster: users }));

        // Send history upon join
        webSocket.send(JSON.stringify({ history: this.messages }));

        // Broadcast join to ALL users (including sender so UI catches it as System notification)
        this.broadcast({ joined: session.name, timestamp: Date.now() });
        webSocket.send(JSON.stringify({ ready: true }));
        return;
      }

      if (data.requestHistory) {
        webSocket.send(JSON.stringify({ history: this.messages }));
        return;
      }

      // Handle name change
      if (data.message !== undefined && data.message.startsWith("/nick ")) {
        let newName = data.message.substring(6).trim();
        if (newName.length > 0 && newName.length <= 32) {
          let oldName = session.name;
          session.name = newName;
          webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });
          this.broadcast({ nameChange: { old: oldName, new: newName }, timestamp: Date.now() });
        }
        return;
      }

      // Handle Edit Message
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

      // Handle Delete Message
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

        // Save and maintain history threshold
        this.messages.push(msgObj);
        if (this.messages.length > 1000) {
          let removed = this.messages.shift();
          this.storage.delete("msg_" + removed.id.padStart(10, "0"));
        }
        this.storage.put("msg_" + msgObj.id.padStart(10, "0"), msgObj);

        this.broadcast(msgObj);
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
      }
    });
  }
}
