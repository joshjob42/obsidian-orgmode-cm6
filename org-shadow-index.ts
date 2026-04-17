import { App, TFile, TFolder, Notice } from "obsidian";
import { LRParser } from "@lezer/lr";
import { extractOrgMetadata, OrgHeadingCache, OrgLinkCache } from "org-metadata";
import { OrgmodePluginSettings } from "settings";

// Shadow-md indexer. For each `.org` file in the vault, emit a companion
// markdown file under the configured folder (default `_o/`). Obsidian's
// native indexer picks these up, which gives full-text search and graph-view
// parity without touching Obsidian internals. Links in shadow content point at
// sibling shadows so real-file backlinks aren't double-counted.

export class OrgShadowIndex {
  constructor(
    private app: App,
    private parser: LRParser,
    private settings: OrgmodePluginSettings,
    private register: (cb: () => void) => void,
  ) {}

  private get folder(): string {
    return (this.settings.shadowIndexFolder || "_o").replace(/^\/+|\/+$/g, "")
  }

  private get enabled(): boolean {
    // On mobile, skip all shadow writes. For iCloud-synced vaults, the desktop
    // already generates shadows and mobile syncs them down — both writing would
    // cause iCloud merge conflicts on every save.
    if ((this.app as any).isMobile) return false
    return this.settings.shadowIndexEnabled !== false
  }

  shadowPathFor(orgPath: string): string {
    return `${this.folder}/${orgPath}.md`
  }

  isShadowPath(path: string): boolean {
    return path.startsWith(this.folder + "/") && path.endsWith(".md")
  }

  originPathFor(shadowPath: string): string | null {
    if (!this.isShadowPath(shadowPath)) return null
    const stripped = shadowPath.slice(this.folder.length + 1, -3)   // trim folder/ … .md
    return stripped
  }

  // Wire vault events. Call once at plugin load.
  async onload(): Promise<void> {
    // Only the desktop generates shadows. On mobile we still want redirect +
    // switcher-filter so shadows that arrived via iCloud sync stay hidden.
    if (this.enabled) {
      this.register(this.app.vault.on("modify", (file: any) => {
        if (file && file.extension === "org") this.writeShadow(file).catch(logErr)
      }) as any)
      this.register(this.app.vault.on("create", (file: any) => {
        if (file && file.extension === "org") this.writeShadow(file).catch(logErr)
      }) as any)
      this.register(this.app.vault.on("delete", (file: any) => {
        if (file && file.extension === "org") this.deleteShadowFor(file.path).catch(logErr)
      }) as any)
      this.register(this.app.vault.on("rename", (file: any, oldPath: string) => {
        if (file && file.extension === "org") this.renameShadow(oldPath, file.path).catch(logErr)
      }) as any)
    }

    this.app.workspace.onLayoutReady(() => {
      if (this.enabled) this.syncAll().catch(logErr)
      // Intercept WorkspaceLeaf.openFile so shadows never get rendered — they're
      // swapped for the real .org file before Obsidian can load them. Catches
      // every open path (quick switcher, search click, file-explorer click,
      // wiki-link, drag-drop) without an event-ordering race or visible flash.
      try { this.patchLeafOpenFile() } catch (e) { logErr(e) }
      // Hide shadow files from the Quick Switcher so users see only the real .org.
      try { this.patchQuickSwitcher() } catch (e) { logErr(e) }
    })
  }

  private patchLeafOpenFile(): void {
    const anyLeaf = this.app.workspace.getLeaf()
    const proto: any = Object.getPrototypeOf(anyLeaf)
    if (proto.__orgShadowPatched) return
    const orig = proto.openFile
    const idx = this
    proto.openFile = function (file: any, state?: any) {
      if (file && file.extension === "md" && idx.isShadowPath(file.path)) {
        const origin = idx.originPathFor(file.path)
        if (origin) {
          const real = idx.app.vault.getFileByPath(origin)
          if (real) return orig.call(this, real, state)
        }
      }
      return orig.call(this, file, state)
    }
    proto.__orgShadowPatched = true
    proto.__origOpenFile = orig
    this.register(() => {
      if (proto.__orgShadowPatched) {
        proto.openFile = proto.__origOpenFile
        delete proto.__origOpenFile
        delete proto.__orgShadowPatched
      }
    })
  }

  private patchQuickSwitcher(): void {
    const sw = (this.app as any).internalPlugins?.plugins?.["switcher"]?.instance
    if (!sw) return
    const tryPatchModalProto = () => {
      // The modal only exists after first open. We need to patch its parent
      // prototype's getSuggestions once we can see it.
      if (!sw.activeModal) return false
      const modalProto: any = Object.getPrototypeOf(Object.getPrototypeOf(sw.activeModal))
      if (modalProto.__orgShadowPatched) return true
      const orig = modalProto.getSuggestions
      const idx = this
      modalProto.getSuggestions = function (query: string) {
        const raw = orig.call(this, query)
        if (!Array.isArray(raw)) return raw
        return raw.filter((sugg: any) => {
          const path = sugg?.file?.path
          return !(path && idx.isShadowPath(path))
        })
      }
      modalProto.__orgShadowPatched = true
      modalProto.__origGetSuggestions = orig
      this.register(() => {
        if (modalProto.__orgShadowPatched) {
          modalProto.getSuggestions = modalProto.__origGetSuggestions
          delete modalProto.__origGetSuggestions
          delete modalProto.__orgShadowPatched
        }
      })
      return true
    }
    // Force-open the modal briefly to grab its prototype, then close.
    if (!sw.activeModal) {
      try {
        sw.onOpen()
        setTimeout(() => {
          tryPatchModalProto()
          sw.activeModal?.close()
        }, 0)
      } catch (e) { /* ignore */ }
    } else {
      tryPatchModalProto()
    }
  }

  // Nuke every file under the shadow folder, then regenerate from scratch.
  // Use when the shadow format has changed and we want to guarantee no stale
  // content lingers in Obsidian's search index.
  async rebuildAll(): Promise<void> {
    if (!this.enabled) return
    const folder = this.app.vault.getAbstractFileByPath(this.folder)
    if (folder instanceof TFolder) {
      const toDelete: TFile[] = []
      const walk = (f: TFolder) => {
        for (const c of f.children) {
          if (c instanceof TFolder) walk(c)
          else if (c instanceof TFile) toDelete.push(c)
        }
      }
      walk(folder)
      for (const f of toDelete) {
        try { await this.app.vault.delete(f) } catch (e) { logErr(e) }
      }
    }
    await this.syncAll()
  }

  async syncAll(): Promise<void> {
    if (!this.enabled) return
    await this.ensureFolder()
    const orgFiles = this.app.vault.getFiles().filter(f => f.extension === "org")
    // Build expected shadow paths.
    const expected = new Set<string>(orgFiles.map(f => this.shadowPathFor(f.path)))
    // Write any missing / stale shadows.
    for (const f of orgFiles) {
      try { await this.writeShadow(f, { ifNewer: true }) } catch (e) { logErr(e) }
    }
    // Delete orphans under the shadow folder.
    const folder = this.app.vault.getAbstractFileByPath(this.folder)
    if (folder instanceof TFolder) {
      const toDelete: TFile[] = []
      const walk = (f: TFolder) => {
        for (const c of f.children) {
          if (c instanceof TFolder) walk(c)
          else if (c instanceof TFile && c.extension === "md") {
            if (!expected.has(c.path)) toDelete.push(c)
          }
        }
      }
      walk(folder)
      for (const f of toDelete) {
        try { await this.app.vault.delete(f) } catch (e) { logErr(e) }
      }
    }
  }

  private async ensureFolder(): Promise<void> {
    const parts = this.folder.split("/")
    let running = ""
    for (const p of parts) {
      running = running ? `${running}/${p}` : p
      const existing = this.app.vault.getAbstractFileByPath(running)
      if (!existing) {
        try { await this.app.vault.createFolder(running) } catch (e) { /* parallel-race OK */ }
      }
    }
  }

  private async renderShadow(orgFile: TFile, orgContent: string): Promise<string> {
    const meta = extractOrgMetadata(this.parser, orgContent)
    const fm = meta.frontmatter || {}
    const lines: string[] = []

    // YAML frontmatter for Obsidian's indexer. Only emit fields we actually want
    // indexed (title/aliases/tags) — no shadow-specific marker, since users see
    // frontmatter fields as highlighted matches in search results.
    const fmLines: string[] = []
    if (fm.title) fmLines.push(`title: ${escapeYaml(String(fm.title))}`)
    if (Array.isArray(fm.aliases) && fm.aliases.length) {
      fmLines.push("aliases:")
      for (const a of fm.aliases) fmLines.push(`  - ${escapeYaml(String(a))}`)
    }
    if (Array.isArray(fm.tags) && fm.tags.length) {
      fmLines.push("tags:")
      for (const t of fm.tags) fmLines.push(`  - ${escapeYaml(String(t))}`)
    }
    if (fmLines.length) {
      lines.push("---")
      lines.push(...fmLines)
      lines.push("---")
      lines.push("")
    }

    // Body: flatten headings, keep paragraph-ish text, rewrite internal links.
    const body = renderOrgBodyForShadow(
      orgContent,
      meta.headings || [],
      meta.links || [],
      this.folder,
      orgFile.path,
      (target) => this.app.metadataCache.getFirstLinkpathDest(target, orgFile.path)?.path ?? null,
    )
    lines.push(body)

    return lines.join("\n")
  }

  async writeShadow(orgFile: TFile, opts: { ifNewer?: boolean } = {}): Promise<void> {
    if (!this.enabled) return
    const shadowPath = this.shadowPathFor(orgFile.path)
    const existing = this.app.vault.getFileByPath(shadowPath)
    if (opts.ifNewer && existing) {
      if (existing.stat.mtime >= orgFile.stat.mtime) {
        // Even if newer, rewrite if the shadow carries old-format addenda that
        // we've since removed (e.g. the `org-shadow-of:` marker or the redirect
        // note) — otherwise stale search matches hang around forever.
        try {
          const head = await this.app.vault.cachedRead(existing)
          const first512 = head.slice(0, 512)
          if (!/(^|\n)org-shadow-of:/.test(first512) && !/Shadow index for \[\[/.test(first512)) {
            return
          }
        } catch { return }
      }
    }
    await this.ensureFolder()
    // Ensure nested parent folders exist.
    const shadowDir = shadowPath.slice(0, shadowPath.lastIndexOf("/"))
    if (shadowDir && shadowDir !== this.folder) {
      const parts = shadowDir.split("/")
      let running = ""
      for (const p of parts) {
        running = running ? `${running}/${p}` : p
        if (!this.app.vault.getAbstractFileByPath(running)) {
          try { await this.app.vault.createFolder(running) } catch { /* ignore */ }
        }
      }
    }
    let content: string
    try {
      const raw = await this.app.vault.read(orgFile)
      content = await this.renderShadow(orgFile, raw)
    } catch (e) {
      logErr(e)
      return
    }
    if (existing) {
      await this.app.vault.modify(existing, content)
    } else {
      await this.app.vault.create(shadowPath, content)
    }
  }

  async deleteShadowFor(orgPath: string): Promise<void> {
    const shadowPath = this.shadowPathFor(orgPath)
    const shadow = this.app.vault.getFileByPath(shadowPath)
    if (shadow) {
      try { await this.app.vault.delete(shadow) } catch (e) { logErr(e) }
    }
  }

  async renameShadow(oldOrgPath: string, newOrgPath: string): Promise<void> {
    const oldShadow = this.app.vault.getFileByPath(this.shadowPathFor(oldOrgPath))
    if (oldShadow) {
      try { await this.app.vault.delete(oldShadow) } catch (e) { logErr(e) }
    }
    const newFile = this.app.vault.getFileByPath(newOrgPath)
    if (newFile) await this.writeShadow(newFile as TFile)
  }
}

function escapeYaml(s: string): string {
  // Minimal YAML-safe quoting — enough for single-line scalars.
  if (/^[\w./\- ]*$/.test(s) && !s.startsWith("-") && !s.startsWith(" ")) return s
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function logErr(e: any): void {
  console.error("[orgmode-cm6] shadow-index error", e)
}

// Flatten org body into markdown text:
// - `* Heading` → `# Heading` (levels preserved up to 6)
// - Strip :PROPERTIES:...:END: drawers
// - Strip top-level `#+KEYWORD:` lines
// - Convert `[[target][alias]]` → `[[<shadow>/target.org.md|alias]]` for org-pointing links
// - Keep `#tag` tokens as-is (Obsidian indexes)
// - Keep body text (inline markup passes through; Obsidian's markdown renderer
//   will show ~code~ etc. as literal, but the indexer just wants the words)
function renderOrgBodyForShadow(
  content: string,
  _headings: OrgHeadingCache[],
  _links: OrgLinkCache[],
  shadowFolder: string,
  _originPath: string,
  resolveTarget: (target: string) => string | null,
): string {
  const lines = content.split("\n")
  const out: string[] = []
  let inDrawer = false
  let skippedKeywordHeader = false   // tracks leading #+KEYWORD: header block
  for (let raw of lines) {
    // Skip :PROPERTIES:…:END: drawers.
    if (/^\s*:PROPERTIES:\s*$/i.test(raw)) { inDrawer = true; continue }
    if (inDrawer) {
      if (/^\s*:END:\s*$/i.test(raw)) { inDrawer = false }
      continue
    }
    // Skip generic `:DRAWERNAME:` drawers (LOGBOOK etc.) at file level.
    if (/^\s*:[A-Z_][A-Z_0-9]*:\s*$/i.test(raw) && !/^\s*:END:/i.test(raw)) {
      // Lookahead-light: attempt to enter drawer if an :END: appears soon.
      inDrawer = true
      continue
    }
    // Skip `#+KEYWORD:` lines.
    if (/^\s*#\+[A-Za-z][A-Za-z0-9_-]*\s*:/.test(raw)) {
      if (!skippedKeywordHeader || out.length === 0) continue
      continue
    }
    skippedKeywordHeader = true
    // Heading conversion.
    const hm = raw.match(/^(\*+)\s+(.*?)\s*(?::[\w@%:#]+:)?\s*$/)
    if (hm) {
      const level = Math.min(hm[1].length, 6)
      const stripTodo = hm[2].replace(/^(?:TODO|DONE|DOING|WAITING|NEXT|PENDING|CANCELLED|CANCELED|CANCEL|REJECTED|STOP|STOPPED)\s+/, "").replace(/^\[#[A-Z]\]\s+/, "")
      out.push(`${"#".repeat(level)} ${stripTodo}`)
      continue
    }
    // Rewrite org links: [[target][alias]] or [[target]]
    raw = raw.replace(/\[\[([^\]]+?)\]\[([^\]]+?)\]\]/g, (_m, tgt, alias) => rewriteLinkToShadow(tgt, alias, shadowFolder, resolveTarget))
    raw = raw.replace(/\[\[([^\]]+?)\]\]/g, (_m, tgt) => rewriteLinkToShadow(tgt, undefined, shadowFolder, resolveTarget))
    out.push(raw)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

function rewriteLinkToShadow(
  target: string,
  alias: string | undefined,
  shadowFolder: string,
  resolveTarget: (target: string) => string | null,
): string {
  // External URLs stay as-is (rendered as a regular markdown link).
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("id:")) {
    return alias ? `[${alias}](${target})` : target
  }
  if (target.startsWith("id:")) {
    return alias ? alias : target
  }
  // Split off subpath.
  const hashIdx = target.indexOf("#")
  const base = hashIdx >= 0 ? target.slice(0, hashIdx) : target
  const subpath = hashIdx >= 0 ? target.slice(hashIdx) : ""
  // Resolve to an actual vault path (accounts for basename matching, folders).
  const candidate = /\.[a-z0-9]{1,8}$/i.test(base) ? base : base + ".org"
  const resolved = resolveTarget(candidate)
  if (!resolved) {
    // Target doesn't exist in the vault. Keep the original link text so
    // Obsidian shows it as unresolved in the shadow too.
    return alias ? `[[${candidate}|${alias}]]` : `[[${candidate}]]`
  }
  // If the resolved path is an org file, point the shadow at the org file's shadow.
  if (resolved.endsWith(".org")) {
    const shadowPath = `${shadowFolder}/${resolved}.md${subpath}`
    return alias
      ? `[[${shadowPath}|${alias}]]`
      : `[[${shadowPath}]]`
  }
  // Non-org resolved file (e.g. image, md). Link at original path.
  return alias ? `[[${resolved}|${alias}]]` : `[[${resolved}${subpath}]]`
}
