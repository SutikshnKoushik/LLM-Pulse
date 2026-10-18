(() => {
  "use strict";

  const root = document.documentElement;
  const dialog = document.getElementById("workspacePaletteDialog");
  const search = document.getElementById("workspacePaletteSearch");
  const results = document.getElementById("workspacePaletteResults");
  const openButton = document.getElementById("workspacePaletteBtn");
  const closeButton = document.getElementById("workspacePaletteCloseBtn");
  const focusButton = document.getElementById("focusModeBtn");
  const densityButton = document.getElementById("densityModeBtn");
  const STORAGE = {
    focus: "llmUsage.workspace.focus",
    compact: "llmUsage.workspace.compact",
    glass: "llmUsage.workspace.glass",
    motion: "llmUsage.workspace.motion"
  };

  const commands = [
    { id: "refresh", label: "Refresh dashboard", detail: "Reload usage and quota observations", icon: "refresh-cw", keywords: "reload update data" },
    { id: "settings", label: "Open settings", detail: "Language, theme, notifications and sources", icon: "sliders-horizontal", keywords: "preferences configuration" },
    { id: "focus", label: "Toggle focus mode", detail: "Hide secondary panels and focus on usage", icon: "scan-eye", keywords: "zen minimal" },
    { id: "compact", label: "Toggle compact layout", detail: "Fit more information on screen", icon: "panels-top-left", keywords: "density tight" },
    { id: "glass", label: "Toggle glass effect", detail: "Switch translucent glass surfaces on or off", icon: "layers-3", keywords: "glassmorphism blur transparency" },
    { id: "motion", label: "Toggle reduced motion", detail: "Reduce animation and transition effects", icon: "accessibility", keywords: "animation accessibility" },
    { id: "providers", label: "Jump to providers", detail: "Browse connected coding agents", icon: "blocks", keywords: "agents models" },
    { id: "codex-resets", label: "Jump to Codex reset history", detail: "Review recorded quota windows and resets", icon: "history", keywords: "codex quota reset" },
    { id: "quota-integrity", label: "Jump to quota integrity", detail: "Inspect collector health and anomalies", icon: "shield-check", keywords: "diagnostics quota issue" },
    { id: "token-history", label: "Jump to token history", detail: "Review local token activity over time", icon: "chart-no-axes-combined", keywords: "usage graph chart" },
    { id: "live", label: "Jump to live metrics", detail: "View current local system and usage metrics", icon: "activity", keywords: "live system cpu memory" },
    { id: "pricing", label: "Jump to pricing", detail: "Inspect model pricing and cost estimates", icon: "wallet", keywords: "cost price" },
    { id: "about", label: "About this project", detail: "View maintainer credit and upstream project", icon: "info", keywords: "credits repository maintainer" }
  ];

  function readFlag(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === "true";
    } catch { return fallback; }
  }

  function saveFlag(key, value) {
    try { localStorage.setItem(key, String(Boolean(value))); } catch { /* session-only preference */ }
  }

  function isEnabled(name) {
    if (name === "focus") return root.classList.contains("workspace-focus-mode");
    if (name === "compact") return root.classList.contains("workspace-compact");
    if (name === "glass") return root.dataset.glass !== "off";
    return root.dataset.motion === "reduced";
  }

  function announce(message) {
    let status = document.getElementById("workspaceStatus");
    if (!status) {
      status = document.createElement("p");
      status.id = "workspaceStatus";
      status.className = "workspace-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      document.querySelector(".app-shell")?.prepend(status);
    }
    status.textContent = message;
    status.hidden = false;
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => { status.hidden = true; }, 2200);
  }

  function syncButtons() {
    const focus = isEnabled("focus");
    const compact = isEnabled("compact");
    if (focusButton) {
      focusButton.setAttribute("aria-pressed", String(focus));
      focusButton.title = focus ? "Exit focus mode · Alt+Shift+F" : "Focus mode · Alt+Shift+F";
    }
    if (densityButton) {
      densityButton.setAttribute("aria-pressed", String(compact));
      densityButton.title = compact ? "Use comfortable layout" : "Use compact layout";
    }
  }

  function setMode(name, enabled, shouldAnnounce = true) {
    if (name === "focus") {
      root.classList.toggle("workspace-focus-mode", enabled);
      saveFlag(STORAGE.focus, enabled);
      if (shouldAnnounce) announce(enabled ? "Focus mode enabled" : "Focus mode disabled");
    } else if (name === "compact") {
      root.classList.toggle("workspace-compact", enabled);
      saveFlag(STORAGE.compact, enabled);
      if (shouldAnnounce) announce(enabled ? "Compact layout enabled" : "Comfortable layout enabled");
    } else if (name === "glass") {
      root.dataset.glass = enabled ? "on" : "off";
      saveFlag(STORAGE.glass, enabled);
      if (shouldAnnounce) announce(enabled ? "Glass effect enabled" : "Glass effect disabled");
    } else if (name === "motion") {
      root.dataset.motion = enabled ? "reduced" : "full";
      saveFlag(STORAGE.motion, enabled);
      if (shouldAnnounce) announce(enabled ? "Reduced motion enabled" : "Full motion enabled");
    }
    syncButtons();
  }

  function jumpTo(id) {
    const target = document.querySelector(`[data-dashboard-panel-id="${CSS.escape(id)}"]`);
    if (!target) {
      announce("That section is not currently available");
      return;
    }
    target.scrollIntoView({ behavior: root.dataset.motion === "reduced" ? "auto" : "smooth", block: "start" });
    target.classList.add("workspace-jump-highlight");
    window.setTimeout(() => target.classList.remove("workspace-jump-highlight"), 1300);
  }

  function runCommand(id) {
    const command = commands.find((item) => item.id === id);
    if (!command) return;
    if (["focus", "compact", "glass", "motion"].includes(id)) {
      setMode(id, !isEnabled(id));
    } else if (id === "refresh") {
      document.getElementById("refreshBtn")?.click();
    } else if (id === "settings") {
      document.getElementById("settingsBtn")?.click();
    } else {
      jumpTo(id);
    }
    closePalette();
  }

  function renderResults() {
    if (!results) return;
    const query = String(search?.value || "").trim().toLowerCase();
    const filtered = commands.filter((command) => `${command.label} ${command.detail} ${command.keywords}`.toLowerCase().includes(query));
    results.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "workspace-palette-empty";
      empty.textContent = "No matching commands";
      results.append(empty);
      return;
    }
    filtered.forEach((command, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-command";
      button.dataset.commandId = command.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === 0));
      const icon = document.createElement("span");
      icon.className = "workspace-command-icon";
      const iconNode = document.createElement("i");
      iconNode.setAttribute("data-lucide", command.icon);
      icon.append(iconNode);
      const copy = document.createElement("span");
      copy.className = "workspace-command-copy";
      const label = document.createElement("strong");
      label.textContent = command.label;
      const detail = document.createElement("span");
      detail.textContent = command.detail;
      copy.append(label, detail);
      button.append(icon, copy);
      button.addEventListener("click", () => runCommand(command.id));
      button.addEventListener("mousemove", () => selectCommand(index));
      results.append(button);
    });
    window.lucide?.createIcons?.({ attrs: { "stroke-width": 1.8 } });
  }

  function selectCommand(index) {
    const items = [...(results?.querySelectorAll(".workspace-command") || [])];
    if (!items.length) return;
    const next = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, itemIndex) => item.setAttribute("aria-selected", String(itemIndex === next)));
    items[next].scrollIntoView({ block: "nearest" });
  }

  function openPalette() {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    if (search) search.value = "";
    renderResults();
    window.requestAnimationFrame(() => search?.focus());
  }

  function closePalette() {
    if (dialog?.open) dialog.close();
    openButton?.focus({ preventScroll: true });
  }

  openButton?.addEventListener("click", openPalette);
  closeButton?.addEventListener("click", closePalette);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closePalette();
  });
  dialog?.addEventListener("close", () => openButton?.focus({ preventScroll: true }));
  search?.addEventListener("input", renderResults);
  search?.addEventListener("keydown", (event) => {
    const items = [...(results?.querySelectorAll(".workspace-command") || [])];
    const selectedIndex = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectCommand(selectedIndex < 0 ? 0 : (selectedIndex + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectCommand(selectedIndex < 0 ? items.length - 1 : (selectedIndex - 1 + items.length) % items.length);
    } else if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      items[selectedIndex].click();
    }
  });
  focusButton?.addEventListener("click", () => setMode("focus", !isEnabled("focus")));
  densityButton?.addEventListener("click", () => setMode("compact", !isEnabled("compact")));

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (dialog?.open) closePalette(); else openPalette();
      return;
    }
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "f" && !typing) {
      event.preventDefault();
      setMode("focus", !isEnabled("focus"));
      return;
    }
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      openPalette();
    }
  });

  setMode("focus", readFlag(STORAGE.focus, false), false);
  setMode("compact", readFlag(STORAGE.compact, false), false);
  setMode("glass", readFlag(STORAGE.glass, true), false);
  setMode("motion", readFlag(STORAGE.motion, Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)), false);
  syncButtons();
})();
