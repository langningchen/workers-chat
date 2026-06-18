window.onload = () => {
    if (window.marked) {
        if (window.markedHighlight && window.hljs) {
            const markedHighlightFn = window.markedHighlight.markedHighlight;
            window.marked.use(markedHighlightFn({
                emptyLangClass: 'hljs',
                langPrefix: 'hljs language-',
                highlight(code, lang) {
                    const language = window.hljs.getLanguage(lang) ? lang : 'plaintext';
                    return window.hljs.highlight(code, { language }).value;
                }
            }));
        }

        if (window.markedKatex) {
            window.marked.use(window.markedKatex({ throwOnError: false }));
        }

        window.marked.setOptions({ breaks: true });
    }
};

let currentWebSocket = null;
let stopReconnect = false;

let authFormContainer = document.querySelector("#auth-form-container");
let authForm = document.querySelector("#auth-form");
let nameInput = document.querySelector("#name-input");
let roomNameInput = document.querySelector("#room-name");
let passwordInput = document.querySelector("#password-input");

let chatroom = document.querySelector("#chatroom");
let chatlog = document.querySelector("#chatlog");
let msgContainer = document.querySelector("#messages-container");
let livePreview = document.querySelector("#live-preview");
let livePreviewContent = livePreview.querySelector(".content");
let chatInput = document.querySelector("#chat-input");
let rosterUsers = document.querySelector("#roster-users");
let editingIndicator = document.querySelector("#editing-indicator");
let unreadAlert = document.querySelector("#unread-alert");

let isAtBottom = true;
let username;
let password;
let roomname;
let editingMsgId = null;
let typingUsers = new Set();
let isTyping = false;
let typingTimeout = null;

let lastSeenTimestamp = 0;
let lastReadMessageId = 0;
let highestMessageId = 0;
let lastLiveMsgData = { name: null, text: null, timestamp: 0 };

let pageIsVisible = document.visibilityState === 'visible';
let pageIsFocused = document.hasFocus();

document.addEventListener('visibilitychange', () => {
    pageIsVisible = document.visibilityState === 'visible';
    if (pageIsVisible) onPageBecameActive();
});
window.addEventListener('focus', () => {
    pageIsFocused = true;
    onPageBecameActive();
});
window.addEventListener('blur', () => {
    pageIsFocused = false;
    updateTitleBar();
    notifyVisibility();
});

function isPageActive() {
    return pageIsVisible && pageIsFocused;
}

function onPageBecameActive() {
    updateReadCursor(false);
    updateTitleBar();
    notifyVisibility();
}

let titleUnreadCount = 0;

function updateTitleBar() {
    if (!roomname) return;

    if (isPageActive()) {
        titleUnreadCount = 0;
    }

    if (titleUnreadCount > 0) {
        document.title = `(${titleUnreadCount}) #${roomname} · Chat`;
    } else {
        document.title = `#${roomname} · Chat`;
    }
}

function incrementTitleUnread() {
    if (!isPageActive()) {
        titleUnreadCount++;
        updateTitleBar();
    }
}

let hostname = window.location.host;
if (hostname == "") {
    hostname = "edge-chat-demo.cloudflareworkers.com";
}
const proto = document.location.protocol === "http:" ? "ws:" : "wss:";

function startAuthForm() {
    let savedName = localStorage.getItem("chat_username");
    if (savedName) nameInput.value = savedName;

    let focusPassword = false;
    if (document.location.hash.length > 1) {
        let hashRoom = document.location.hash.slice(1);
        roomNameInput.value = hashRoom;
        if (savedName) {
            focusPassword = true;
        }
    }

    authForm.addEventListener("submit", event => {
        event.preventDefault();
        username = nameInput.value.trim();
        roomname = roomNameInput.value.trim();
        password = passwordInput.value;

        if (username.length > 0 && roomname.length > 0) {
            if (!username.match(/^[A-Za-z0-9\-_]{1,32}$/)) {
                alert("Invalid nickname. Only letters, numbers, hyphens, and underscores are allowed.");
                return;
            }
            localStorage.setItem("chat_username", username);
            startChat();
        }
    });

    nameInput.addEventListener("input", event => {
        if (event.currentTarget.value.length > 32) event.currentTarget.value = event.currentTarget.value.slice(0, 32);
    });
    roomNameInput.addEventListener("input", event => {
        if (event.currentTarget.value.length > 32) event.currentTarget.value = event.currentTarget.value.slice(0, 32);
    });

    if (focusPassword) {
        passwordInput.focus();
    } else {
        nameInput.focus();
    }
}

function updateReadCursor(force = false) {
    if ((isAtBottom || force) && isPageActive()) {
        if (highestMessageId > lastReadMessageId) {
            lastReadMessageId = highestMessageId;
            if (currentWebSocket && currentWebSocket.readyState === 1) {
                currentWebSocket.send(JSON.stringify({ readCursor: lastReadMessageId }));
            }
        }
        if (isAtBottom) {
            unreadAlert.style.display = "none";
        }
        titleUnreadCount = 0;
        updateTitleBar();
    }
}

unreadAlert.addEventListener("click", () => {
    chatlog.scrollBy(0, 1e8);
    unreadAlert.style.display = "none";
});

function autoResizeInput() {
    if (chatInput.value === "") {
        chatInput.dataset.manuallyResized = "false";
        chatInput.style.height = '80px';
    } else if (chatInput.dataset.manuallyResized !== "true") {
        chatInput.style.height = '80px';
        chatInput.style.height = Math.min(chatInput.scrollHeight, window.innerHeight * 0.5) + 'px';
    }
}

new ResizeObserver(() => {
    document.documentElement.style.setProperty('--input-height', chatInput.offsetHeight + 'px');
    if (isAtBottom) chatlog.scrollBy(0, 1e8);
}).observe(chatInput);

chatInput.addEventListener("mousedown", () => {
    const startHeight = chatInput.offsetHeight;
    const onMouseUp = () => {
        if (chatInput.offsetHeight !== startHeight) {
            chatInput.dataset.manuallyResized = "true";
        }
        document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mouseup", onMouseUp);
});

function startEditing(id, rawText) {
    editingMsgId = id;
    chatInput.value = rawText;

    autoResizeInput();

    chatInput.focus();
    editingIndicator.style.display = "block";
    updatePreview();
}

function cancelEditing() {
    editingMsgId = null;
    chatInput.value = "";

    autoResizeInput();

    editingIndicator.style.display = "none";
    updatePreview();
}

function updatePreview() {
    let text = chatInput.value.trim();
    if (text === "" || text.startsWith("/")) {
        livePreview.style.display = "none";
        livePreviewContent.innerHTML = "";
        return;
    }
    livePreview.style.display = "block";
    let html = window.marked ? window.marked.parse(text) : text;
    html = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
    livePreviewContent.innerHTML = html;

    if (isAtBottom) chatlog.scrollBy(0, 100);
}

function submitMessage() {
    let text = chatInput.value.trim();
    if (text === "") return;

    if (text === "/clear") {
        msgContainer.innerHTML = "";
        localStorage.setItem("clearedAt_" + roomname, Date.now());
        addChatMessage("System", "Chat history cleared locally. (Hidden from your view only)", Date.now(), null, false, true);
        cancelEditing();
        return;
    }
    if (text === "/help") {
        let helpText = "**Commands:**\n\n" +
            "- `/nick <name>` : Change nickname\n" +
            "- `/clear` : Clear local chat view history\n" +
            "- `/help` : Show this help\n\n" +
            "**Shortcuts:**\n\n" +
            "- **Shift+Enter** : Insert new line\n" +
            "- **UP arrow** (in empty input) : Edit your last message\n" +
            "- **Ctrl + UP** : Quick reply to the latest message\n" +
            "- **PageUp / PageDown** : Scroll chat history while typing\n" +
            "- **Esc** : Cancel edit / Close image preview";
        addChatMessage("System", helpText, Date.now(), null, false, true);
        cancelEditing();
        return;
    }

    if (editingMsgId) {
        if (currentWebSocket) currentWebSocket.send(JSON.stringify({ edit: editingMsgId, text: text }));
        cancelEditing();
    } else {
        if (currentWebSocket) currentWebSocket.send(JSON.stringify({ message: text }));
        chatInput.value = "";
        autoResizeInput();
        updatePreview();
    }

    isTyping = false;
    if (typingTimeout) clearTimeout(typingTimeout);
    if (currentWebSocket && currentWebSocket.readyState === 1) {
        currentWebSocket.send(JSON.stringify({ typing: false }));
    }

    chatlog.scrollBy(0, 1e8);
}

function startChat() {
    authFormContainer.style.display = "none";
    chatroom.style.display = "block";

    roomname = roomname.replace(/[^a-zA-Z0-9_-]/g, "").replace(/_/g, "-").toLowerCase();
    document.location.hash = "#" + roomname;
    updateTitleBar();

    chatInput.addEventListener("input", (e) => {
        autoResizeInput();
        updatePreview();

        if (!isTyping) {
            isTyping = true;
            if (currentWebSocket && currentWebSocket.readyState === 1) {
                currentWebSocket.send(JSON.stringify({ typing: true }));
            }
        }
        if (typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            isTyping = false;
            if (currentWebSocket && currentWebSocket.readyState === 1) {
                currentWebSocket.send(JSON.stringify({ typing: false }));
            }
        }, 3000);
    });

    chatInput.addEventListener("keydown", event => {
        if (event.keyCode == 13 && !event.shiftKey) {
            event.preventDefault();
            submitMessage();
        } else if (event.keyCode == 38 && !event.ctrlKey && chatInput.value === "") {
            let myMsgs = document.querySelectorAll(`.msg-item[data-name="${username}"]`);
            if (myMsgs.length > 0) {
                let lastMsg = myMsgs[myMsgs.length - 1];
                let rawText = lastMsg.getAttribute("data-raw-text");
                let id = lastMsg.id.replace("msg_", "");
                startEditing(id, rawText);
                event.preventDefault();
            }
        } else if (event.keyCode == 38 && event.ctrlKey) {
            event.preventDefault();
            let allMsgs = document.querySelectorAll('.msg-item[id^="msg_"]');
            if (allMsgs.length > 0) {
                let lastMsg = allMsgs[allMsgs.length - 1];
                let replyBtn = lastMsg.querySelector('.reply-btn');
                if (replyBtn) replyBtn.click();
            }
        } else if (event.keyCode == 33) {
            chatlog.scrollBy({ top: -chatlog.clientHeight * 0.8, behavior: 'smooth' });
            event.preventDefault();
        } else if (event.keyCode == 34) {
            chatlog.scrollBy({ top: chatlog.clientHeight * 0.8, behavior: 'smooth' });
            event.preventDefault();
        } else if (event.keyCode == 27 && editingMsgId) {
            cancelEditing();
            event.preventDefault();
        }
    });

    chatInput.addEventListener("paste", async event => {
        let items = (event.clipboardData || event.originalEvent.clipboardData).items;
        for (let index in items) {
            let item = items[index];
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                event.preventDefault();
                let blob = item.getAsFile();
                let reader = new FileReader();
                reader.onload = async (e) => {
                    let base64 = e.target.result;
                    chatInput.value += " (Uploading...)";
                    autoResizeInput();
                    updatePreview();
                    try {
                        let response = await fetch('/upload', { method: 'POST', body: base64 });
                        if (!response.ok) throw new Error("Server rejected upload");
                        let imageId = await response.text();
                        chatInput.value = chatInput.value.replace(" (Uploading...)", `\n![](/${imageId})`);
                        autoResizeInput();
                        updatePreview();
                    } catch (err) {
                        chatInput.value = chatInput.value.replace(" (Uploading...)", " (Upload failed)");
                        autoResizeInput();
                        updatePreview();
                    }
                };
                reader.readAsDataURL(blob);
            }
        }
    });

    chatlog.addEventListener("scroll", event => {
        isAtBottom = chatlog.scrollTop + chatlog.clientHeight >= chatlog.scrollHeight - 20;
        updateReadCursor();
    });

    chatlog.addEventListener('click', (e) => {
        let target = e.target.closest('a[href^="#msg_"]');
        if (target) {
            e.preventDefault();
            let id = target.getAttribute('href').substring(1);
            let el = document.getElementById(id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.style.backgroundColor = '#fff9c4';
                el.style.transition = 'background-color 0.5s ease';
                setTimeout(() => el.style.backgroundColor = 'transparent', 2000);
                setTimeout(() => el.style.transition = '', 2500);
            }
        }
    });

    chatInput.focus();
    document.body.addEventListener("click", event => {
        if (window.getSelection().toString() == "") chatInput.focus();
    });

    if ('visualViewport' in window) {
        window.visualViewport.addEventListener('resize', function () {
            if (isAtBottom) chatlog.scrollBy(0, 1e8);
        });
    }

    join();
}

let pingInterval = null;

function notifyVisibility() {
    if (currentWebSocket && currentWebSocket.readyState === 1) {
        currentWebSocket.send(JSON.stringify({ status: isPageActive() ? 'active' : 'background' }));
    }
}

function updateRosterView(rosterArray) {
    rosterUsers.innerHTML = "";
    rosterArray.forEach(user => {
        let p = document.createElement("div");
        p.className = "roster-user";
        p.id = "roster-user-" + user.name;

        let icon = user.status === 'background' ? "🌙" : "🟢";
        let color = user.status === 'background' ? "#888" : "#000";

        let nameSpan = document.createElement("span");
        nameSpan.innerText = `${icon} ${user.name}`;
        nameSpan.style.color = color;
        p.appendChild(nameSpan);

        if (user.unread > 0) {
            let badge = document.createElement("span");
            badge.className = "unread-badge";
            badge.innerText = user.unread;
            p.appendChild(badge);
        }

        rosterUsers.appendChild(p);
    });
}

function triggerHeartEasterEgg() {
    for (let i = 0; i < 40; i++) {
        let heart = document.createElement("div");
        heart.innerText = "❤";
        heart.className = "heart-particle";
        heart.style.left = (Math.random() * 95) + "vw";
        heart.style.animationDuration = (Math.random() * 2 + 2) + "s";
        heart.style.color = Math.random() > 0.5 ? "#ff4081" : "#f44336";
        document.body.appendChild(heart);
        setTimeout(() => heart.remove(), 4000);
    }
}

function updateTypingIndicator() {
    let typingDiv = document.getElementById("typing-indicator");
    if (typingUsers.size === 0) {
        typingDiv.style.display = "none";
    } else {
        typingDiv.style.display = "block";
        let arr = Array.from(typingUsers);
        if (arr.length === 1) typingDiv.innerText = `${arr[0]} is typing...`;
        else if (arr.length === 2) typingDiv.innerText = `${arr[0]} and ${arr[1]} are typing...`;
        else typingDiv.innerText = `Several people are typing...`;
    }
}

async function join() {
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        await Notification.requestPermission();
    }

    const wss = proto === "ws:" ? "ws://" : "wss://";
    let ws = new WebSocket(wss + hostname + "/api/room/" + roomname + "/websocket");
    let rejoined = false;
    let startTime = Date.now();

    let connStatus = document.getElementById("connection-status");
    connStatus.style.display = "block";
    connStatus.innerText = "Connecting to server...";
    connStatus.style.backgroundColor = "#ff9800";

    let rejoin = async () => {
        if (!rejoined && !stopReconnect) {
            rejoined = true;
            currentWebSocket = null;
            while (rosterUsers.firstChild) rosterUsers.removeChild(rosterUsers.firstChild);

            let timeSinceLastJoin = Date.now() - startTime;
            if (timeSinceLastJoin < 5000) {
                await new Promise(resolve => setTimeout(resolve, 5000 - timeSinceLastJoin));
            }
            join();
        }
    };

    ws.addEventListener("open", event => {
        currentWebSocket = ws;
        connStatus.innerText = "Connected";
        connStatus.style.backgroundColor = "#4caf50";
        setTimeout(() => {
            if (currentWebSocket === ws) connStatus.style.display = "none";
        }, 2000);

        ws.send(JSON.stringify({
            name: username,
            password: password,
            status: isPageActive() ? 'active' : 'background'
        }));

        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 2000);
    });

    ws.addEventListener("message", event => {
        handleWsMessage(event.data);
    });

    ws.addEventListener("close", event => {
        if (!stopReconnect) {
            connStatus.style.display = "block";
            connStatus.innerText = "Disconnected. Reconnecting...";
            connStatus.style.backgroundColor = "#f44336";
            if (pingInterval) clearInterval(pingInterval);
            rejoin();
        }
    });

    ws.addEventListener("error", event => {
        if (!stopReconnect) {
            connStatus.style.display = "block";
            connStatus.innerText = "Connection error. Reconnecting...";
            connStatus.style.backgroundColor = "#f44336";
            if (pingInterval) clearInterval(pingInterval);
            rejoin();
        }
    });
}

function handleWsMessage(dataStr) {
    if (dataStr === "pong") return;
    let data = JSON.parse(dataStr);
    let clearedAt = parseInt(localStorage.getItem("clearedAt_" + roomname)) || 0;

    if (data.error) {
        addChatMessage("System", "* Error: " + data.error, Date.now(), null, false, true);
        if (data.error.includes("password") || data.error.includes("Nickname") || data.error.includes("nickname") || data.error.includes("Invalid")) {
            stopReconnect = true;
        }
    } else if (data.typing) {
        if (data.typing.isTyping) {
            typingUsers.add(data.typing.name);
        } else {
            typingUsers.delete(data.typing.name);
        }
        updateTypingIndicator();
    } else if (data.roster) {
        updateRosterView(data.roster);
    } else if (data.joined) {
        if (data.timestamp >= clearedAt) {
            addChatMessage("System", `**${data.joined === username ? "You" : data.joined}** joined the room.`, data.timestamp, null, false, true);
        }
    } else if (data.nameChange) {
        if (data.timestamp >= clearedAt) {
            addChatMessage("System", `**${data.nameChange.old === username ? "You are" : data.nameChange.old}** is now known as **${data.nameChange.new}**.`, data.timestamp, null, false, true);
        }
    } else if (data.quit) {
        typingUsers.delete(data.quit);
        updateTypingIndicator();
        if (data.timestamp >= clearedAt) {
            addChatMessage("System", `**${data.quit}** left the room.`, data.timestamp, null, false, true);
        }
    } else if (data.ready) {
        updateReadCursor();
    } else if (data.history) {
        msgContainer.innerHTML = "";
        data.history.forEach(m => {
            let msgIdInt = parseInt(m.id);
            if (msgIdInt > highestMessageId) highestMessageId = msgIdInt;

            if (m.timestamp >= clearedAt) {
                if (m.timestamp > lastSeenTimestamp) lastSeenTimestamp = m.timestamp;
                addChatMessage(m.name, m.message, m.timestamp, m.id, m.edited, false, true);
            }
        });
        setTimeout(() => {
            chatlog.scrollBy(0, 1e8);
            updateReadCursor();
        }, 100);
    } else if (data.edited) {
        let msgDiv = document.getElementById("msg_" + data.edited);
        if (msgDiv) renderMessageContent(msgDiv, msgDiv.getAttribute("data-name"), data.text, data.edited, true);
    } else if (data.deleted) {
        let msgDiv = document.getElementById("msg_" + data.deleted);
        if (msgDiv) msgDiv.remove();
    } else {
        let msgIdInt = parseInt(data.id);
        if (msgIdInt > highestMessageId) highestMessageId = msgIdInt;

        if (data.timestamp >= clearedAt) {
            let wasAtBottom = isAtBottom;

            if (data.message === "❤" || data.message === "❤️") {
                let cleanLastText = lastLiveMsgData.text ? lastLiveMsgData.text.replace(/[\uFE0F]/g, '') : '';
                if (cleanLastText === "❤" && lastLiveMsgData.name !== data.name && (data.timestamp - lastLiveMsgData.timestamp < 60000)) {
                    triggerHeartEasterEgg();
                }
            }
            lastLiveMsgData = { name: data.name, text: data.message, timestamp: data.timestamp };

            addChatMessage(data.name, data.message, data.timestamp, data.id, data.edited);
            lastSeenTimestamp = data.timestamp;

            if (wasAtBottom && isPageActive()) {
                chatlog.scrollBy(0, 1e8);
                updateReadCursor(true);
            } else {
                unreadAlert.style.display = "block";
                incrementTitleUnread();

                if (!isPageActive() && Notification.permission === "granted" && data.name !== username) {
                    let unreadCount = highestMessageId - lastReadMessageId;
                    let bodyText = unreadCount > 0
                        ? `New message received (${unreadCount} unread)`
                        : "New message received";

                    new Notification(data.name + " in #" + roomname, {
                        icon: "/favicon.ico",
                        body: bodyText,
                        tag: "chat-room-" + roomname
                    });
                }
            }
        }
    }
}

function renderMessageContent(msgDiv, name, text, id, isEdited, isSystem = false) {
    let content = msgDiv.querySelector(".content");
    if (!content) return;
    msgDiv.setAttribute("data-raw-text", text);

    let html = window.marked ? window.marked.parse(text) : text;
    html = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;

    if (isSystem) {
        content.innerHTML = html;
        content.classList.add("system-text");
    } else if (name) {
        if (html.includes(`@${username}`)) {
            let mentionRegex = new RegExp(`@${username}\\b`, 'gi');
            html = html.replace(mentionRegex, `<span class="mention">$&</span>`);
        }

        content.innerHTML = html;

        let actionsSpan = document.createElement("span");
        actionsSpan.style.display = "inline";
        actionsSpan.style.marginLeft = "8px";
        actionsSpan.style.fontSize = "0.8em";

        if (isEdited) {
            let editedSpan = document.createElement("span");
            editedSpan.innerText = "(edited) ";
            editedSpan.style.color = "#888";
            actionsSpan.appendChild(editedSpan);
        }

        if (id) {
            let repBtn = document.createElement("a");
            repBtn.innerText = "[Reply]";
            repBtn.href = "javascript:void(0)";
            repBtn.style.marginRight = "6px";
            repBtn.style.color = "#28a745";
            repBtn.style.textDecoration = "none";
            repBtn.className = "reply-btn";
            repBtn.onclick = () => {
                let rawText = msgDiv.getAttribute("data-raw-text");
                let cleanText = rawText.replace(/\[💬.*?\]\(#msg_\d+\)\s*/g, '').replace(/\n/g, ' ').substring(0, 25);
                if (rawText.length > 25) cleanText += "...";
                chatInput.value = `[💬 Replying to @${name}: "${cleanText}"](#msg_${id})\n` + chatInput.value;
                autoResizeInput();
                chatInput.focus();
                updatePreview();
            };
            actionsSpan.appendChild(repBtn);

            let copyBtn = document.createElement("a");
            copyBtn.innerText = "[Copy MD]";
            copyBtn.href = "javascript:void(0)";
            copyBtn.style.marginRight = "6px";
            copyBtn.style.color = "#6c757d";
            copyBtn.style.textDecoration = "none";
            copyBtn.onclick = async () => {
                let rawText = msgDiv.getAttribute("data-raw-text");
                try {
                    await navigator.clipboard.writeText(rawText);
                    let oldText = copyBtn.innerText;
                    copyBtn.innerText = "[Copied!]";
                    copyBtn.style.color = "#28a745";
                    setTimeout(() => {
                        copyBtn.innerText = oldText;
                        copyBtn.style.color = "#6c757d";
                    }, 2000);
                } catch (err) {
                    alert("Failed to copy: " + err);
                }
            };
            actionsSpan.appendChild(copyBtn);
        }

        if (name === username && id) {
            let editBtn = document.createElement("a");
            editBtn.innerText = "[Edit]";
            editBtn.href = "javascript:void(0)";
            editBtn.style.marginRight = "6px";
            editBtn.style.color = "#0066cc";
            editBtn.style.textDecoration = "none";
            editBtn.onclick = () => {
                let rawText = msgDiv.getAttribute("data-raw-text");
                startEditing(id, rawText);
            };

            let delBtn = document.createElement("a");
            delBtn.innerText = "[Delete]";
            delBtn.href = "javascript:void(0)";
            delBtn.style.color = "#cc0000";
            delBtn.style.textDecoration = "none";
            delBtn.onclick = () => {
                if (confirm("Delete this message?")) {
                    if (currentWebSocket) currentWebSocket.send(JSON.stringify({ delete: id }));
                }
            };

            actionsSpan.appendChild(editBtn);
            actionsSpan.appendChild(delBtn);
        }

        if (actionsSpan.hasChildNodes()) {
            content.appendChild(actionsSpan);
        }
    } else {
        content.innerText = text;
    }

    content.querySelectorAll('img').forEach(img => {
        img.style.cursor = "pointer";
        img.title = "Click to enlarge";
        img.onclick = () => {
            let overlay = document.createElement("div");
            overlay.style.position = "fixed";
            overlay.style.top = "0"; overlay.style.left = "0";
            overlay.style.width = "100%"; overlay.style.height = "100%";
            overlay.style.backgroundColor = "rgba(0,0,0,0.85)";
            overlay.style.zIndex = "1000";
            overlay.style.display = "flex";
            overlay.style.alignItems = "center";
            overlay.style.justifyContent = "center";
            overlay.style.cursor = "zoom-out";

            let closeOverlay = () => {
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            };
            overlay.onclick = closeOverlay;

            let escListener = (e) => {
                if (e.keyCode === 27) closeOverlay();
            };
            document.addEventListener('keydown', escListener);

            let fullImg = document.createElement("img");
            fullImg.src = img.src;
            fullImg.style.maxWidth = "90%";
            fullImg.style.maxHeight = "90%";
            fullImg.style.borderRadius = "8px";
            fullImg.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
            overlay.appendChild(fullImg);
            document.body.appendChild(overlay);
        };
    });
}

function addChatMessage(name, text, timestamp, id, isEdited, isSystem = false, skipScroll = false) {
    let p = document.createElement("div");
    p.className = "msg-item";
    if (id) {
        p.id = "msg_" + id;
        p.setAttribute("data-name", name);
    }

    if (timestamp) {
        let timeTag = document.createElement("span");
        timeTag.style.display = "inline";
        timeTag.style.color = "#888";
        timeTag.style.fontSize = "0.8em";
        timeTag.style.marginRight = "8px";
        let date = new Date(timestamp);
        timeTag.innerText = `[${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}]`;
        p.appendChild(timeTag);
    }

    if (name) {
        let tag = document.createElement("span");
        tag.className = "username";
        tag.style.display = "inline";
        tag.innerText = name + ": ";
        tag.style.marginRight = "4px";

        if (!isSystem) {
            tag.classList.add("clickable");
            tag.title = "Click to mention";
            tag.style.cursor = "pointer";
            tag.onclick = () => {
                chatInput.value += `@${name} `;
                chatInput.focus();
            };
        } else {
            tag.style.color = "#888";
        }

        p.appendChild(tag);
    }

    let content = document.createElement("div");
    content.className = "content";
    content.style.display = "inline";

    p.appendChild(content);
    msgContainer.appendChild(p);

    renderMessageContent(p, name, text, id, isEdited, isSystem);

    if (!skipScroll && isAtBottom) {
        chatlog.scrollBy(0, 1e8);
    }
}

startAuthForm();
