import { App, Plugin, MarkdownPostProcessorContext, TFile, MarkdownRenderer, Component } from "obsidian";

// Post-processor: when a markdown file contains `![[file.org]]` (optionally
// with a #subpath), Obsidian's default renderer shows a generic "file embed"
// placeholder because it has no org renderer. We intercept those elements and
// render the org content as HTML.

export function registerOrgEmbedPostProcessor(plugin: Plugin): void {
  const handle = (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const embeds = el.querySelectorAll(".internal-embed[src]")
    embeds.forEach((node) => {
      const raw = node.getAttribute("src") || ""
      const hashIdx = raw.indexOf("#")
      const linkpath = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
      const subpath = hashIdx >= 0 ? raw.slice(hashIdx + 1) : ""
      const tfile = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, ctx.sourcePath)
        || plugin.app.metadataCache.getFirstLinkpathDest(linkpath.endsWith(".org") ? linkpath : linkpath + ".org", ctx.sourcePath)
      if (!tfile || tfile.extension !== "org") return
      waitAndReplace(plugin.app, node as HTMLElement, tfile, subpath, ctx)
    })
  }
  plugin.registerMarkdownPostProcessor(handle)
}

// Obsidian's default file-embed renderer runs AFTER all post-processors finish
// and adds `file-embed mod-generic` classes + a `.file-embed-title` child. We
// watch the container for that marker, then replace it with our render. The
// observer survives Obsidian re-renders (e.g. when reading-mode refreshes).
function waitAndReplace(
  app: App,
  container: HTMLElement,
  file: TFile,
  subpath: string,
  ctx: MarkdownPostProcessorContext,
): void {
  if ((container as any).__orgEmbedObserver) return
  const maybeRender = () => {
    // Trigger when Obsidian has added the default `file-embed-title` placeholder.
    if (container.classList.contains("file-embed") && container.querySelector(".file-embed-title")) {
      renderOrgEmbed(app, container, file, subpath, ctx)
    }
  }
  const observer = new MutationObserver(maybeRender)
  observer.observe(container, { childList: true, attributes: true, attributeFilter: ["class"] })
  ;(container as any).__orgEmbedObserver = observer
  // In case Obsidian already finished before we installed the observer.
  maybeRender()
}

async function renderOrgEmbed(
  app: App,
  container: HTMLElement,
  file: TFile,
  subpath: string,
  ctx: MarkdownPostProcessorContext,
): Promise<void> {
  // Disconnect our observer while we mutate, otherwise our changes retrigger it.
  const observer: MutationObserver | undefined = (container as any).__orgEmbedObserver
  observer?.disconnect()
  try {
    container.empty()
    container.addClass("org-embed")
    container.addClass("org-embed-ready")
    container.removeClass("mod-generic")
    container.removeClass("file-embed")
    container.addClass("markdown-embed")
    const titleEl = container.createDiv({ cls: "markdown-embed-title" })
    titleEl.setText(subpath ? `${file.basename} > ${subpath}` : file.basename)
    const contentEl = container.createDiv({ cls: "markdown-embed-content" })

    const content = await app.vault.cachedRead(file)
    const fragment = subpath ? extractSubpath(content, subpath) : content
    const markdown = orgToMarkdown(fragment)

    // Defer to Obsidian's Markdown renderer so links, lists, code blocks etc.
    // all render natively.
    const child = new Component()
    ctx.addChild(child as any)
    await MarkdownRenderer.render(app, markdown, contentEl, file.path, child as any)

    // Make the title clickable to open the real file.
    titleEl.addEventListener("click", (e) => {
      e.preventDefault()
      app.workspace.openLinkText(file.path + (subpath ? "#" + subpath : ""), ctx.sourcePath, false)
    })
  } catch (e) {
    console.error("[orgmode-cm6] embed render error", e)
  } finally {
    // Re-observe so subsequent Obsidian re-renders (e.g. ones that reset classes)
    // trigger another replacement.
    observer?.observe(container, { childList: true, attributes: true, attributeFilter: ["class"] })
  }
}

function extractSubpath(content: string, subpath: string): string {
  // Support `#Heading` navigation — capture from the matching heading through
  // the next heading at the same level or higher.
  const target = subpath.replace(/^#+/, "").trim().toLowerCase()
  if (!target) return content
  const lines = content.split("\n")
  let startIdx = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\*+)\s+(.*?)\s*(?::[\w@%:#]+:)?\s*$/)
    if (!m) continue
    const title = m[2].replace(/^(?:TODO|DONE|DOING|WAITING|NEXT|PENDING|CANCELLED|CANCELED|CANCEL|REJECTED|STOP|STOPPED)\s+/, "").replace(/^\[#[A-Z]\]\s+/, "").trim()
    if (title.toLowerCase() === target) {
      startIdx = i
      level = m[1].length
      break
    }
  }
  if (startIdx < 0) return content   // fallback: full file
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\*+)\s+/)
    if (m && m[1].length <= level) { endIdx = i; break }
  }
  return lines.slice(startIdx, endIdx).join("\n")
}

// Light conversion: enough for embedded preview. Full fidelity isn't the goal.
export function orgToMarkdown(content: string): string {
  const lines = content.split("\n")
  const out: string[] = []
  let inDrawer = false
  for (let raw of lines) {
    if (/^\s*:PROPERTIES:\s*$/i.test(raw)) { inDrawer = true; continue }
    if (inDrawer) { if (/^\s*:END:\s*$/i.test(raw)) inDrawer = false; continue }
    // Strip top-level keyword lines.
    if (/^\s*#\+[A-Za-z][A-Za-z0-9_-]*\s*:/.test(raw)) continue
    // Heading.
    const hm = raw.match(/^(\*+)\s+(.*?)\s*(?::[\w@%:#]+:)?\s*$/)
    if (hm) {
      const level = Math.min(hm[1].length, 6)
      const stripTodo = hm[2].replace(/^(?:TODO|DONE|DOING|WAITING|NEXT|PENDING|CANCELLED|CANCELED|CANCEL|REJECTED|STOP|STOPPED)\s+/, "").replace(/^\[#[A-Z]\]\s+/, "")
      out.push(`${"#".repeat(level)} ${stripTodo}`)
      continue
    }
    // Convert org markup to markdown:
    //   *bold* → **bold** (single-word)
    //   /italic/ → *italic*
    //   ~code~ and =verbatim= → `code`
    //   _underline_ → <u>underline</u>
    //   +strike+ → ~~strike~~
    raw = raw.replace(/(^|\s)\*([^*\s][^*]*[^*\s]|\S)\*(?=\s|[.,;:!?)]|$)/g, (_m, p1, inner) => `${p1}**${inner}**`)
    raw = raw.replace(/(^|\s)\/([^/\s][^/]*[^/\s]|\S)\/(?=\s|[.,;:!?)]|$)/g, (_m, p1, inner) => `${p1}*${inner}*`)
    raw = raw.replace(/(^|\s)~([^~\s][^~]*[^~\s]|\S)~/g, (_m, p1, inner) => `${p1}\`${inner}\``)
    raw = raw.replace(/(^|\s)=([^=\s][^=]*[^=\s]|\S)=/g, (_m, p1, inner) => `${p1}\`${inner}\``)
    raw = raw.replace(/(^|\s)\+([^+\s][^+]*[^+\s]|\S)\+/g, (_m, p1, inner) => `${p1}~~${inner}~~`)
    // Convert links:
    //   [[url][alias]] → [alias](url) for external, [[target|alias]] for internal
    //   [[url]] → <url> for external, [[target]] for internal
    raw = raw.replace(/\[\[([^\]]+?)\]\[([^\]]+?)\]\]/g, (_m, tgt, alias) => convertLink(tgt, alias))
    raw = raw.replace(/\[\[([^\]]+?)\]\]/g, (_m, tgt) => convertLink(tgt, undefined))
    out.push(raw)
  }
  return out.join("\n")
}

function convertLink(target: string, alias: string | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("id:")) {
    return alias ? `[${alias}](${target})` : `<${target}>`
  }
  // Internal: leave as markdown wiki-link so the embed's inner markdown renderer resolves it.
  const candidate = /\.[a-z0-9]{1,8}$/i.test(target) ? target : target + ".org"
  return alias ? `[[${candidate}|${alias}]]` : `[[${candidate}]]`
}
