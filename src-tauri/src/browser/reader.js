// Reader mode: finds the article on the page and shows only that, in a calm layout.
// Works on the page's own content, inside the page; reloading brings the page back.
// Returns false when no article is found.
(() => {
  const score = new Map();
  const add = (el, n) => el && el !== document.body && score.set(el, (score.get(el) || 0) + n);
  for (const p of document.querySelectorAll("p, pre, blockquote")) {
    const text = p.innerText ? p.innerText.trim() : "";
    if (text.length < 40) continue;
    const links = [...p.querySelectorAll("a")].reduce((n, a) => n + a.innerText.length, 0);
    const value = text.length - links * 2;
    add(p.parentElement, value);
    add(p.parentElement && p.parentElement.parentElement, value / 2);
  }
  let best = null;
  let top = 0;
  for (const [el, n] of score) {
    if (n > top) {
      best = el;
      top = n;
    }
  }
  if (!best || top < 400) return false;

  const title = (document.querySelector("h1") || {}).innerText || document.title;
  const copy = best.cloneNode(true);
  const drop = "script,style,link,noscript,iframe,object,embed,form,input,button,select,textarea,nav,aside,footer,header,svg,canvas,video,audio,[aria-hidden='true'],[hidden]";
  copy.querySelectorAll(drop).forEach((e) => e.remove());
  const keep = new Set(["src", "srcset", "alt", "href", "title", "colspan", "rowspan"]);
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      if (!keep.has(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  const first = copy.querySelector("h1");
  if (first) first.remove();

  document.querySelectorAll("link[rel='stylesheet'],style").forEach((e) => e.remove());
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    "html{background:#14161a;color:#d8dade;color-scheme:dark}" +
      "body{margin:0;padding:48px 20px;font:19px/1.7 Georgia,'Times New Roman',serif}" +
      "main{max-width:720px;margin:0 auto}h1{font-size:34px;line-height:1.25;margin:0 0 28px}h2,h3,h4{line-height:1.3;margin:1.6em 0 .5em}" +
      "a{color:#8ab4f8}img,figure{max-width:100%;height:auto;margin:1em 0}pre{overflow:auto;padding:12px;background:#0c0d10;font-size:15px}" +
      "blockquote{margin:1em 0;padding-left:16px;border-left:3px solid #4a4d55;color:#b6b8bd}table{border-collapse:collapse}td,th{border:1px solid #33363c;padding:4px 8px}",
  );
  document.adoptedStyleSheets = [sheet];
  const main = document.createElement("main");
  const h1 = document.createElement("h1");
  h1.textContent = title.trim();
  main.append(h1, copy);
  document.body.replaceChildren(main);
  document.body.removeAttribute("style");
  document.body.removeAttribute("class");
  scrollTo(0, 0);
  return true;
})();
