// This is the Edge Chat Demo Worker, built using Durable Objects!

import HTML from "./chat.html";

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
      let blockedMessages = [];
      let lastActive = Date.now();
      this.sessions.set(webSocket, { ...meta, blockedMessages, lastActive });
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

    let session = { blockedMessages: [], lastActive: Date.now() };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), lastActive: session.lastActive });
    this.sessions.set(webSocket, session);

    if (!this.pingInterval) {
      this.pingInterval = setInterval(() => this.checkTimeout(), 2000);
    }

    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({ joined: otherSession.name }));
      }
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

        // Send history upon join
        webSocket.send(JSON.stringify({ history: this.messages }));

        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        this.broadcast({ joined: session.name });
        webSocket.send(JSON.stringify({ ready: true }));
        return;
      }

      // Handle name change
      if (data.message !== undefined && data.message.startsWith("/nick ")) {
        let newName = data.message.substring(6).trim();
        if (newName.length > 0 && newName.length <= 32) {
          let oldName = session.name;
          session.name = newName;
          webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });
          this.broadcast({ nameChange: { old: oldName, new: newName } });
        }
        return;
      }

      // Handle Edit Message
      if (data.edit) {
        let msgId = data.edit;
        let newText = data.text;

        let targetMsg = this.messages.find(m => m.id === msgId);
        // Make sure user is the one who originally sent it
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
      this.broadcast({ quit: session.name });
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
      } else {
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({ quit: quitter.name });
      }
    });
  }
}
