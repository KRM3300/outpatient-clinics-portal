/* Language preference shared by the portal and its public service entry pages. */
window.OPDLanguage = (() => {
  const key = "opd-portal-language";
  let selected = "ar";
  function read() {
    try {
      selected = localStorage.getItem(key) === "en" ? "en" : "ar";
    } catch {
      // The language switch still works when browser storage is disabled.
    }
    return selected;
  }
  function save(language) {
    selected = language;
    try {
      localStorage.setItem(key, language);
    } catch {
      // Keep the current page usable without storage.
    }
  }
  function applyServiceEntry() {
    if (read() !== "en") return;
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
    for (const element of document.querySelectorAll("[data-en]")) {
      element.textContent = element.dataset.en;
    }
    const logo = document.querySelector(".site-logo");
    if (logo) logo.alt = "Al Rass General Hospital logo";
  }
  return { read, save, applyServiceEntry };
})();
