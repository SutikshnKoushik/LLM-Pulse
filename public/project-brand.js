(() => {
  "use strict";

  // Personalize this workspace here. Keep upstream ownership and links separate
  // from the local display name; leave profileUrl empty until it is verified.
  const brand = Object.freeze({
    projectName: "LLM Pulse — AI Usage Intelligence",
    subtitle: "AI Usage Intelligence",
    displayName: "Ayush",
    profileUrl: "https://github.com/SutikshnKoushik",
    repositoryUrl: "https://github.com/SutikshnKoushik/LLM-Pulse/",
    upstreamMaintainer: "Gerhard Kollinger",
    upstreamProfileUrl: "https://github.com/kollinger",
    upstreamRepositoryUrl: "https://github.com/kollinger/llm-usage-dashboard"
  });

  window.LLM_USAGE_PROJECT_BRAND = brand;

  document.querySelectorAll("[data-project-name]").forEach((element) => {
    element.textContent = brand.projectName;
  });
  document.querySelectorAll("[data-project-subtitle]").forEach((element) => {
    element.textContent = brand.subtitle;
  });
  document.querySelectorAll("[data-project-owner]").forEach((element) => {
    element.textContent = brand.displayName;
  });
  const home = document.querySelector("[data-project-home]");
  if (home) home.setAttribute("aria-label", `${brand.projectName} home`);

  const profile = document.querySelector("[data-upstream-profile]");
  if (profile) {
    profile.textContent = brand.upstreamMaintainer;
    profile.href = brand.upstreamProfileUrl;
  }
  const repository = document.querySelector("[data-upstream-repository]");
  if (repository) repository.href = brand.upstreamRepositoryUrl;

  function showVerifiedHttpsLink(selector, value, label) {
    if (!value) return;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return;
      const link = document.querySelector(selector);
      if (!link) return;
      link.href = url.href;
      link.hidden = false;
      link.setAttribute("aria-label", label);
    } catch {
      // Keep unverified or malformed links hidden until the config is corrected.
    }
  }

  showVerifiedHttpsLink("[data-personal-profile]", brand.profileUrl, `${brand.displayName} profile`);
  showVerifiedHttpsLink("[data-personal-repository]", brand.repositoryUrl, "Personal project repository");
})();
