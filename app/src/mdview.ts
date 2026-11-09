// Markdown on screen (what an AI says in 相談). Built from text nodes only:
// whatever the text holds, it shows as words and runs nothing. A link is not
// followed (the app's window would leave the name): clicking copies it.
import { type MdBlock, type MdInline, parseMarkdown } from "./markdown";

function inline(parts: MdInline[], copied: (href: string) => void): Node[] {
  return parts.map((part): Node => {
    switch (part.t) {
      case "text":
        return document.createTextNode(part.v);
      case "br":
        return document.createElement("br");
      case "code": {
        const code = document.createElement("code");
        code.textContent = part.v;
        return code;
      }
      case "link": {
        const link = document.createElement("span");
        link.className = "md-link";
        link.title = `${part.href}（クリックでコピー）`;
        link.append(...inline(part.c, copied));
        link.addEventListener("click", () => copied(part.href));
        return link;
      }
      default: {
        const node = document.createElement(part.t === "strong" ? "strong" : part.t === "em" ? "em" : "del");
        node.append(...inline(part.c, copied));
        return node;
      }
    }
  });
}

function block(item: MdBlock, copied: (href: string) => void): HTMLElement {
  switch (item.t) {
    case "h": {
      const node = document.createElement(`h${Math.min(6, item.level + 2)}` as "h3");
      node.append(...inline(item.c, copied));
      return node;
    }
    case "p": {
      const node = document.createElement("p");
      node.append(...inline(item.c, copied));
      return node;
    }
    case "hr":
      return document.createElement("hr");
    case "quote": {
      const node = document.createElement("blockquote");
      node.append(...item.blocks.map((inner) => block(inner, copied)));
      return node;
    }
    case "code": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = item.v;
      pre.append(code);
      return pre;
    }
    case "list": {
      const node = document.createElement(item.ordered ? "ol" : "ul");
      if (item.ordered && item.start !== 1) node.setAttribute("start", String(item.start));
      for (const entry of item.items) {
        const li = document.createElement("li");
        li.append(...entry.map((inner) => block(inner, copied)));
        node.append(li);
      }
      return node;
    }
    case "table": {
      const wrap = document.createElement("div");
      wrap.className = "md-table";
      const table = document.createElement("table");
      const row = (cells: MdInline[][], tag: "th" | "td") => {
        const tr = document.createElement("tr");
        cells.forEach((cell, k) => {
          const td = document.createElement(tag);
          if (item.align[k]) td.style.textAlign = item.align[k];
          td.append(...inline(cell, copied));
          tr.append(td);
        });
        return tr;
      };
      const head = document.createElement("thead");
      head.append(row(item.head, "th"));
      const body = document.createElement("tbody");
      body.append(...item.rows.map((cells) => row(cells, "td")));
      table.append(head, body);
      wrap.append(table);
      return wrap;
    }
  }
}

/** `text` as Markdown, in an element of class `md`. */
export function markdownView(text: string, copied: (href: string) => void): HTMLElement {
  const view = document.createElement("div");
  view.className = "md";
  view.append(...parseMarkdown(text).map((item) => block(item, copied)));
  return view;
}
