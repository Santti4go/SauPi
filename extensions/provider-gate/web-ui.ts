export const PROVIDER_GATE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pi Provider Gate</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    * { box-sizing: border-box; }
    body { margin: 0; display: flex; min-height: 100vh; background: #070907; color: #d7e2d8; }
    aside { position: sticky; top: 0; flex: 0 0 116px; width: 116px; height: 100vh; overflow: hidden; border-right: 1px solid #29432f; background: #090d0a; transition: width .15s, flex-basis .15s; }
    aside.collapsed { flex-basis: 42px; width: 42px; }
    .side-head { display: flex; align-items: center; min-height: 48px; padding: 7px; border-bottom: 1px solid #203527; }
    #toggle-sidebar { width: 28px; height: 28px; padding: 0; }
    .side-title { margin-left: 8px; color: #78917d; font-size: 10px; white-space: nowrap; }
    aside.collapsed .side-title, aside.collapsed .nav-label { display: none; }
    nav { display: grid; gap: 5px; padding: 7px; overflow-y: auto; max-height: calc(100vh - 48px); }
    nav button { width: 100%; padding: 6px 4px; text-align: left; white-space: nowrap; }
    aside.collapsed nav button { text-align: center; }
    #content { flex: 1; min-width: 0; }
    #topbar { position: sticky; top: 0; z-index: 2; background: #0b100c; box-shadow: 0 5px 18px #0008; }
    #metrics-bar { display: flex; flex-wrap: wrap; align-items: stretch; gap: 1px; min-height: 54px; border-bottom: 1px solid #29432f; background: #18241b; }
    .metric { position: relative; min-width: 120px; flex: 1 1 auto; padding: 8px 12px; background: #0a0f0b; overflow: hidden; }
    .metric.context { min-width: 210px; flex-grow: 1.6; }
    .metric-label { display: block; margin-bottom: 3px; color: #617a67; font-size: 9px; letter-spacing: .12em; }
    .metric-value { position: relative; z-index: 1; color: #b7c9ba; font-size: 12px; white-space: nowrap; }
    .metric.context .metric-value { color: #72ff94; }
    .context-track { position: absolute; inset: auto 0 0; height: 3px; background: #17231a; }
    .context-fill { display: block; height: 100%; max-width: 100%; background: #72ff94; transition: width .2s; }
    .context-fill.warning { background: #e4c95d; }
    .context-fill.danger { background: #ff7087; }
    header { display: flex; justify-content: space-between; gap: 16px; padding: 11px 18px; border-bottom: 1px solid #34513b; background: #0b100c; }
    h1 { margin: 0; font-size: 15px; color: #72ff94; }
    #connection { color: #78917d; font-size: 12px; }
    main { padding: 16px; display: grid; gap: 14px; }
    article { scroll-margin-top: 126px; border: 1px solid #29432f; background: #0b100c; }
    article.pending { border-color: #72ff94; }
    article.approved { border-color: #376e45; opacity: .82; }
    article.bypassed { border-color: #315976; opacity: .9; }
    article.rejected { border-color: #a24455; opacity: .82; }
    article.cancelled { opacity: .6; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #203527; font-size: 12px; }
    .number, .status { text-transform: uppercase; font-weight: 700; }
    .number { color: #b7c9ba; }
    .pending .status { color: #72ff94; }
    .rejected .status { color: #ff7087; }
    .approved .status { color: #68d984; }
    .bypassed .status { color: #7bb8ff; }
    .edited { color: #d8c86c; }
    .projected { color: #7bb8ff; }
    .request-only { color: #ff9cab; }
    .actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }
    .view-active { border-color: #72ff94; color: #72ff94; }
    button { border: 1px solid #42644a; background: #122017; color: #d7e2d8; padding: 7px 13px; font: inherit; cursor: pointer; }
    button:hover { border-color: #72ff94; }
    button.reject:hover { border-color: #ff7087; color: #ff9cab; }
    pre, textarea { width: 100%; margin: 0; padding: 14px; border: 0; background: #0b100c; color: #d7e2d8; overflow: auto; max-height: 68vh; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
    textarea { display: block; min-height: 58vh; resize: vertical; outline: 1px solid #72ff94; outline-offset: -1px; white-space: pre; }
    .error { padding: 9px 12px; border-top: 1px solid #a24455; color: #ff9cab; font-size: 12px; }
    #empty { color: #78917d; padding: 30px; text-align: center; }
    @media (max-width: 680px) { aside { flex-basis: 42px; width: 42px; } .side-title, .nav-label { display: none; } h1 { font-size: 12px; } .metric { min-width: 105px; } .metric.context { min-width: 100%; } }
  </style>
</head>
<body>
  <aside id="sidebar">
    <div class="side-head"><button id="toggle-sidebar" title="Toggle history" aria-label="Toggle history">‹</button><span class="side-title">HISTORY</span></div>
    <nav id="history"></nav>
  </aside>
  <div id="content">
    <div id="topbar">
      <section id="metrics-bar" aria-label="Pi session metrics"><div class="metric"><span class="metric-label">TELEMETRY</span><span class="metric-value">waiting for Pi…</span></div></section>
      <header><h1>PI // PROVIDER AUTHORIZATION GATE</h1><span id="connection">connecting</span></header>
    </div>
    <main id="reviews"><div id="empty">Waiting for a provider payload…</div></main>
  </div>
  <script>
    const token = new URLSearchParams(location.search).get("token");
    const reviews = new Map();
    const drafts = new Map();
    const editing = new Set();
    const errors = new Map();
    const views = new Map();
    const root = document.querySelector("#reviews");
    const history = document.querySelector("#history");
    const sidebar = document.querySelector("#sidebar");
    const toggleSidebar = document.querySelector("#toggle-sidebar");
    const connection = document.querySelector("#connection");
    const metricsBar = document.querySelector("#metrics-bar");

    function formatBytes(bytes) {
      return bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(1) + " KiB";
    }

    function formatTokens(value) {
      if (value === null || value === undefined) return "?";
      if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 1 : 2) + "M";
      if (value >= 1000) return (value / 1000).toFixed(value >= 100000 ? 0 : 1) + "K";
      return String(value);
    }

    function metric(label, value, title, className) {
      const item = document.createElement("div");
      item.className = "metric" + (className ? " " + className : "");
      item.title = title;
      const name = document.createElement("span");
      name.className = "metric-label";
      name.textContent = label;
      const output = document.createElement("span");
      output.className = "metric-value";
      output.textContent = value;
      item.append(name, output);
      return item;
    }

    function renderMetrics(metrics) {
      metricsBar.replaceChildren();
      const context = metrics.context;
      const contextValue = context
        ? formatTokens(context.tokens) + " / " + formatTokens(context.contextWindow) + (context.percent === null ? " (?)" : " (" + context.percent.toFixed(1) + "%)")
        : "not available";
      const contextMetric = metric("PI CONTEXT", contextValue, "Pi context estimate before provider-gate payload rewrites", "context");
      if (context) {
        const track = document.createElement("span");
        track.className = "context-track";
        const fill = document.createElement("span");
        const percent = context.percent ?? 0;
        fill.className = "context-fill" + (percent > 90 ? " danger" : percent > 70 ? " warning" : "");
        fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
        track.append(fill);
        contextMetric.append(track);
      }
      const tokenTitle = "Input " + metrics.tokens.input.toLocaleString() + ", output " + metrics.tokens.output.toLocaleString() + ", cache read " + metrics.tokens.cacheRead.toLocaleString() + ", cache write " + metrics.tokens.cacheWrite.toLocaleString();
      const tokenMetric = metric("SESSION TOKENS", formatTokens(metrics.tokens.total), tokenTitle);
      const ioMetric = metric("IN / OUT", formatTokens(metrics.tokens.input) + " / " + formatTokens(metrics.tokens.output), tokenTitle);
      const cacheMetric = metric("CACHE R / W", formatTokens(metrics.tokens.cacheRead) + " / " + formatTokens(metrics.tokens.cacheWrite), tokenTitle);
      const costValue = metrics.billing === "subscription" ? "subscription" : metrics.cost === null ? "not available" : "$" + metrics.cost.toFixed(4);
      const costMetric = metric("COST", costValue, metrics.billing === "subscription" ? "Provider authenticated through an OAuth subscription" : "Accumulated cost reported by Pi");
      const modelValue = metrics.model ? metrics.model.provider + "/" + metrics.model.id : "not available";
      const modelMetric = metric("MODEL", modelValue, modelValue);
      metricsBar.append(contextMetric, tokenMetric, ioMetric, cacheMetric, costMetric, modelMetric);
    }

    function currentText(review) {
      return drafts.get(review.id) ?? review.sentPayload;
    }

    function isObject(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    function containsToolData(value) {
      if (Array.isArray(value)) return value.some(containsToolData);
      if (!isObject(value)) return false;
      if (["function_call", "function_call_output", "tool_call", "tool_result", "functionResponse"].includes(value.type) || value.role === "tool") return true;
      return (Array.isArray(value.content) && value.content.some(containsToolData)) || (Array.isArray(value.parts) && value.parts.some(containsToolData));
    }

    function isHumanUser(value) {
      return isObject(value) && value.role === "user" && !containsToolData(value);
    }

    function itemList(payload) {
      if (!isObject(payload)) return undefined;
      if (Array.isArray(payload.input)) return { owner: payload, key: "input", items: payload.input };
      if (Array.isArray(payload.messages)) return { owner: payload, key: "messages", items: payload.messages };
      if (Array.isArray(payload.contents)) return { owner: payload, key: "contents", items: payload.contents };
      return undefined;
    }

    function collectText(value, output) {
      if (typeof value === "string") output.push(value);
      else if (Array.isArray(value)) for (const item of value) collectText(item, output);
      else if (isObject(value)) {
        if (typeof value.text === "string") output.push(value.text);
        else if (typeof value.content === "string") output.push(value.content);
        else if (Array.isArray(value.content)) collectText(value.content, output);
      }
    }

    function userMessage(text, fallback) {
      try {
        const payload = JSON.parse(text);
        if (typeof payload.input === "string") return payload.input;
        const list = itemList(payload);
        const user = list ? [...list.items].reverse().find(isHumanUser) : undefined;
        if (!user) return fallback ?? "No human user message found.";
        const output = [];
        collectText(user.content ?? user.parts ?? user.text, output);
        return output.length > 0 ? output.join("\n") : JSON.stringify(user, null, 2);
      } catch {
        return fallback ?? "The edited payload is not valid JSON.";
      }
    }

    async function removeLastTurn(review) {
      errors.delete(review.id);
      const response = await fetch("/requests/" + encodeURIComponent(review.id) + "/drop-last-turn?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: currentText(review)
      });
      if (response.ok) {
        drafts.delete(review.id);
        editing.delete(review.id);
        views.set(review.id, "sent");
      } else {
        errors.set(review.id, await response.text());
      }
      render();
    }

    async function decide(review, decision) {
      errors.delete(review.id);
      const options = { method: "POST" };
      if (decision === "approve") {
        options.headers = { "content-type": "text/plain; charset=utf-8" };
        options.body = currentText(review);
      }
      const response = await fetch("/requests/" + encodeURIComponent(review.id) + "/" + decision + "?token=" + encodeURIComponent(token), options);
      if (!response.ok) {
        errors.set(review.id, await response.text());
        render();
      }
    }

    async function copyPayload(review, button) {
      const view = views.get(review.id) ?? "sent";
      const text = view === "raw" ? review.rawPayload : view === "user" ? userMessage(currentText(review), review.userMessage) : currentText(review);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const helper = document.createElement("textarea");
        helper.value = text;
        document.body.append(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      button.textContent = "COPIED";
      setTimeout(() => { button.textContent = "COPY"; }, 900);
    }

    function toggleEdit(review) {
      if (editing.has(review.id)) editing.delete(review.id);
      else {
        editing.add(review.id);
        views.set(review.id, "sent");
        if (!drafts.has(review.id)) drafts.set(review.id, review.sentPayload);
      }
      errors.delete(review.id);
      render();
      if (editing.has(review.id)) document.querySelector("#editor-" + CSS.escape(review.id))?.focus();
    }

    function renderHistory(values) {
      history.replaceChildren();
      for (const review of [...values].sort((left, right) => left.sequence - right.sequence)) {
        const button = document.createElement("button");
        const number = document.createElement("span");
        number.textContent = "#" + review.sequence;
        const label = document.createElement("span");
        label.className = "nav-label";
        label.textContent = " " + review.status;
        button.title = "Request #" + review.sequence + " — " + review.status;
        button.append(number, label);
        button.onclick = () => document.querySelector("#review-" + CSS.escape(review.id))?.scrollIntoView({ behavior: "smooth", block: "start" });
        history.append(button);
      }
    }

    function render() {
      root.replaceChildren();
      const values = [...reviews.values()].sort((left, right) => right.sequence - left.sequence);
      renderHistory(values);
      if (values.length === 0) {
        const empty = document.createElement("div");
        empty.id = "empty";
        empty.textContent = "Waiting for a provider payload…";
        root.append(empty);
        return;
      }

      for (const review of values) {
        const article = document.createElement("article");
        article.id = "review-" + review.id;
        article.className = review.status;
        const meta = document.createElement("div");
        meta.className = "meta";
        const number = document.createElement("span");
        number.className = "number";
        number.textContent = "#" + review.sequence;
        const status = document.createElement("span");
        status.className = "status";
        status.textContent = review.status;
        const timestamp = document.createElement("span");
        timestamp.textContent = new Date(review.createdAt).toLocaleString();
        const size = document.createElement("span");
        size.textContent = formatBytes(new TextEncoder().encode(currentText(review)).length);
        meta.append(number, status, timestamp, size);
        if (review.modified || (drafts.has(review.id) && currentText(review) !== review.sentPayload)) {
          const edited = document.createElement("span");
          edited.className = "edited";
          edited.textContent = "EDITED";
          meta.append(edited);
        }
        if (review.appliedOperations > 0) {
          const projected = document.createElement("span");
          projected.className = "projected";
          projected.textContent = review.appliedOperations + " PROJECTED";
          meta.append(projected);
        }
        if (review.requestOnlyChanges) {
          const requestOnly = document.createElement("span");
          requestOnly.className = "request-only";
          requestOnly.textContent = "REQUEST-ONLY";
          meta.append(requestOnly);
        }

        const actions = document.createElement("div");
        actions.className = "actions";
        const copy = document.createElement("button");
        copy.textContent = "COPY";
        copy.onclick = () => copyPayload(review, copy);
        actions.append(copy);

        const payloadView = document.createElement("button");
        payloadView.textContent = "SENT";
        if ((views.get(review.id) ?? "sent") === "sent") payloadView.className = "view-active";
        payloadView.onclick = () => { views.set(review.id, "sent"); render(); };
        const rawView = document.createElement("button");
        rawView.textContent = "RAW PI";
        if (views.get(review.id) === "raw") rawView.className = "view-active";
        rawView.onclick = () => { views.set(review.id, "raw"); render(); };
        const userView = document.createElement("button");
        userView.textContent = "USER";
        if (views.get(review.id) === "user") userView.className = "view-active";
        userView.onclick = () => { views.set(review.id, "user"); render(); };
        actions.append(payloadView, rawView, userView);
        if (review.status === "pending") {
          const edit = document.createElement("button");
          edit.textContent = editing.has(review.id) ? "PREVIEW" : "EDIT";
          edit.onclick = () => toggleEdit(review);
          const approve = document.createElement("button");
          approve.textContent = "ACCEPT";
          approve.onclick = () => decide(review, "approve");
          const reject = document.createElement("button");
          reject.className = "reject";
          reject.textContent = "REJECT";
          reject.onclick = () => decide(review, "reject");
          const removeTurn = document.createElement("button");
          removeTurn.className = "reject";
          removeTurn.textContent = "DROP LAST TURN";
          removeTurn.onclick = () => removeLastTurn(review);
          actions.append(edit, removeTurn, approve, reject);
        }
        meta.append(actions);

        const text = currentText(review);
        let payload;
        if (views.get(review.id) === "raw") {
          payload = document.createElement("pre");
          payload.textContent = review.rawPayload;
        } else if (views.get(review.id) === "user") {
          payload = document.createElement("pre");
          payload.textContent = userMessage(text, review.userMessage);
        } else if (editing.has(review.id) && review.status === "pending") {
          payload = document.createElement("textarea");
          payload.id = "editor-" + review.id;
          payload.value = text;
          payload.spellcheck = false;
          payload.oninput = () => {
            drafts.set(review.id, payload.value);
            size.textContent = formatBytes(new TextEncoder().encode(payload.value).length);
          };
        } else {
          payload = document.createElement("pre");
          payload.textContent = text;
        }
        article.append(meta, payload);
        if (errors.has(review.id)) {
          const error = document.createElement("div");
          error.className = "error";
          error.textContent = errors.get(review.id);
          article.append(error);
        }
        if (review.persistenceWarning) {
          const warning = document.createElement("div");
          warning.className = "error";
          warning.textContent = review.persistenceWarning;
          article.append(warning);
        }
        root.append(article);
      }
    }

    function update(review) {
      reviews.set(review.id, review);
      if (review.status !== "pending") {
        drafts.delete(review.id);
        editing.delete(review.id);
        errors.delete(review.id);
      }
      render();
    }

    toggleSidebar.onclick = () => {
      sidebar.classList.toggle("collapsed");
      toggleSidebar.textContent = sidebar.classList.contains("collapsed") ? "›" : "‹";
    };

    const events = new EventSource("/events?token=" + encodeURIComponent(token));
    events.addEventListener("snapshot", event => {
      reviews.clear();
      for (const review of JSON.parse(event.data)) reviews.set(review.id, review);
      render();
    });
    events.addEventListener("review", event => update(JSON.parse(event.data)));
    events.addEventListener("metrics", event => renderMetrics(JSON.parse(event.data)));
    events.onopen = () => { connection.textContent = "connected"; };
    events.onerror = () => { connection.textContent = "disconnected — retrying"; };
  </script>
</body>
</html>`;
