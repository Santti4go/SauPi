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
    header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; padding: 14px 18px; border-bottom: 1px solid #34513b; background: #0b100c; }
    h1 { margin: 0; font-size: 15px; color: #72ff94; }
    #connection { color: #78917d; font-size: 12px; }
    main { padding: 16px; display: grid; gap: 14px; }
    article { scroll-margin-top: 62px; border: 1px solid #29432f; background: #0b100c; }
    article.pending { border-color: #72ff94; }
    article.approved { border-color: #376e45; opacity: .82; }
    article.rejected { border-color: #a24455; opacity: .82; }
    article.cancelled { opacity: .6; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #203527; font-size: 12px; }
    .number, .status { text-transform: uppercase; font-weight: 700; }
    .number { color: #b7c9ba; }
    .pending .status { color: #72ff94; }
    .rejected .status { color: #ff7087; }
    .approved .status { color: #68d984; }
    .edited { color: #d8c86c; }
    .actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 1px solid #42644a; background: #122017; color: #d7e2d8; padding: 7px 13px; font: inherit; cursor: pointer; }
    button:hover { border-color: #72ff94; }
    button.reject:hover { border-color: #ff7087; color: #ff9cab; }
    pre, textarea { width: 100%; margin: 0; padding: 14px; border: 0; background: #0b100c; color: #d7e2d8; overflow: auto; max-height: 68vh; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
    textarea { display: block; min-height: 58vh; resize: vertical; outline: 1px solid #72ff94; outline-offset: -1px; white-space: pre; }
    .error { padding: 9px 12px; border-top: 1px solid #a24455; color: #ff9cab; font-size: 12px; }
    #empty { color: #78917d; padding: 30px; text-align: center; }
    @media (max-width: 680px) { aside { flex-basis: 42px; width: 42px; } .side-title, .nav-label { display: none; } h1 { font-size: 12px; } }
  </style>
</head>
<body>
  <aside id="sidebar">
    <div class="side-head"><button id="toggle-sidebar" title="Toggle history" aria-label="Toggle history">‹</button><span class="side-title">HISTORY</span></div>
    <nav id="history"></nav>
  </aside>
  <div id="content">
    <header><h1>PI // PROVIDER AUTHORIZATION GATE</h1><span id="connection">connecting</span></header>
    <main id="reviews"><div id="empty">Waiting for a provider payload…</div></main>
  </div>
  <script>
    const token = new URLSearchParams(location.search).get("token");
    const reviews = new Map();
    const drafts = new Map();
    const editing = new Set();
    const errors = new Map();
    const root = document.querySelector("#reviews");
    const history = document.querySelector("#history");
    const sidebar = document.querySelector("#sidebar");
    const toggleSidebar = document.querySelector("#toggle-sidebar");
    const connection = document.querySelector("#connection");

    function formatBytes(bytes) {
      return bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(1) + " KiB";
    }

    function currentText(review) {
      return drafts.get(review.id) ?? review.payload;
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
      const text = currentText(review);
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
        if (!drafts.has(review.id)) drafts.set(review.id, review.payload);
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
        if (drafts.has(review.id) && currentText(review) !== review.payload) {
          const edited = document.createElement("span");
          edited.className = "edited";
          edited.textContent = "EDITED";
          meta.append(edited);
        }

        const actions = document.createElement("div");
        actions.className = "actions";
        const copy = document.createElement("button");
        copy.textContent = "COPY";
        copy.onclick = () => copyPayload(review, copy);
        actions.append(copy);
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
          actions.append(edit, approve, reject);
        }
        meta.append(actions);

        const text = currentText(review);
        let payload;
        if (editing.has(review.id) && review.status === "pending") {
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
    events.onopen = () => { connection.textContent = "connected"; };
    events.onerror = () => { connection.textContent = "disconnected — retrying"; };
  </script>
</body>
</html>`;
